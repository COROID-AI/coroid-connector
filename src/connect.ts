import {
  CONNECTOR_POLL_SECONDS,
  parseConnectorTurn,
  parseConnectorTurnDirective,
  type ConnectorDescription,
  type ConnectorTurn,
  type ConnectorTurnDirective,
  type ConnectorTurnEvent,
} from './protocol/local-agents.js';
import { SignedOut } from './session.js';

/** How many turns run at once on one machine by default (Phase 5e, E6): the Developer's explorers run beside it. */
export const TURNS_AT_ONCE = 4;
export const MAX_CONCURRENCY = 8;
const FIRST_RETRY_SECONDS = 5;
const LONGEST_RETRY_SECONDS = 60;
const NOT_SERVED_RETRY_SECONDS = 60;
const POLL_TIMEOUT_MS = 45_000;
const REPORT_TIMEOUT_MS = 30_000;
const REPORT_RETRIES = 3;
const SLEEP_JUMP_THRESHOLD_MS = 30_000;

type Session = { accessToken(): Promise<string>; renew(): Promise<string> };

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'paused'
  | 'reconnecting'
  | 'not_served'
  | 'stopping';

export interface ConnectionControl {
  /** Forces a fresh machine description probe and wakes any sleeping poll. */
  requestRecheck(): void;
  /** Pauses or resumes accepting new turns without disconnecting. */
  setPaused(paused: boolean): void;
  isPaused(): boolean;
}

export interface PollMetrics {
  latencyMs: number;
  hasTurn: boolean;
  pollAfterSeconds: number;
}

type Answer =
  | {
      kind: 'work';
      pollAfterSeconds: number;
      turn: ConnectorTurn | null;
      unreadable: boolean;
      latencyMs: number;
    }
  | { kind: 'describe' }
  | { kind: 'token_refused' }
  | { kind: 'not_served'; reason: string }
  | { kind: 'failed'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function safeParseJson(raw: string): unknown {
  if (!raw.trimStart().startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function combinedSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([parent, timeout])
    : parent;
}

async function ask(
  api: string,
  token: string,
  body: unknown,
  signal: AbortSignal
): Promise<Answer> {
  const startedAt = Date.now();
  const response = await fetch(`${api}/connector/v1/poll`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: combinedSignal(signal, POLL_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - startedAt;
  // An answer that is not JSON (a proxy's error page) is a failure like any other; its status says which.
  const raw = await response.text();
  const said = safeParseJson(raw);
  const record = isRecord(said) ? said : {};
  const reason =
    typeof record.error_description === 'string'
      ? record.error_description
      : `status ${response.status}`;
  if (response.status === 200) {
    const pace = record.pollAfterSeconds;
    const turn = record.turn == null ? null : parseConnectorTurn(record.turn);
    return {
      kind: 'work',
      pollAfterSeconds:
        typeof pace === 'number' && pace >= 1 && pace <= 300
          ? pace
          : CONNECTOR_POLL_SECONDS,
      turn,
      unreadable: record.turn != null && turn === null,
      latencyMs,
    };
  }
  if (response.status === 409) return { kind: 'describe' };
  if (response.status === 401) return { kind: 'token_refused' };
  if (response.status === 403 || response.status === 503)
    return { kind: 'not_served', reason };
  return { kind: 'failed', reason };
}

/**
 * Keeps this machine connected: asks CoRoid for work at the pace CoRoid
 * names, which is also the machine's heartbeat. It describes the machine
 * until CoRoid has taken the description, and again when CoRoid asks or when
 * the operator triggers `check`. It ends when it is told to stop, or when the
 * machine's sign-in is over.
 */
export async function stayConnected(options: {
  api: string;
  session: Session;
  describe(): Promise<ConnectorDescription>;
  /** Runs a turn CoRoid handed over, to its end. Up to `maxConcurrency` run at once. */
  work(turn: ConnectorTurn): Promise<void>;
  /** Waits; returns early when `signal` fires. */
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
  say(line: string): void;
  signal: AbortSignal;
  /** Maximum concurrent turns (default 4, clamped 1..8). */
  maxConcurrency?: number;
  /** Receives interactive control hooks (recheck, pause/resume). */
  onControl?(control: ConnectionControl): void;
  /** Called when the high-level connection state changes. */
  onStateChange?(state: ConnectionState, detail?: string): void;
  /** Called after every successful poll with latency & pacing metrics. */
  onPoll?(metrics: PollMetrics): void;
}): Promise<'stopped' | 'signed_out'> {
  const limit = Math.max(
    1,
    Math.min(
      MAX_CONCURRENCY,
      Math.floor(options.maxConcurrency ?? TURNS_AT_ONCE)
    )
  );
  let described = false;
  let renewalDue = false;
  let renewedWithoutSuccess = false;
  let failures = 0;
  let paused = false;
  let lastSaid = '';
  let state: ConnectionState = 'connecting';
  let wakeController = new AbortController();

  const setState = (next: ConnectionState, detail?: string): void => {
    if (next !== state || detail) {
      state = next;
      options.onStateChange?.(next, detail);
    }
  };
  const wake = (): void => {
    wakeController.abort();
    wakeController = new AbortController();
  };
  const say = (line: string): void => {
    if (line !== lastSaid) options.say(line);
    lastSaid = line;
  };

  const control: ConnectionControl = {
    requestRecheck: () => {
      described = false;
      wake();
    },
    setPaused: next => {
      if (paused === next) return;
      paused = next;
      setState(paused ? 'paused' : described ? 'connected' : 'connecting');
      wake();
    },
    isPaused: () => paused,
  };
  options.onControl?.(control);

  const sleepInterruptible = async (seconds: number): Promise<void> => {
    const started = Date.now();
    const localWake = wakeController;
    const sleepAbort = new AbortController();
    const forward = (): void => sleepAbort.abort();
    if (options.signal.aborted || localWake.signal.aborted) return;
    options.signal.addEventListener('abort', forward, { once: true });
    localWake.signal.addEventListener('abort', forward, { once: true });
    try {
      await options.sleep(seconds, sleepAbort.signal);
    } finally {
      options.signal.removeEventListener('abort', forward);
      localWake.signal.removeEventListener('abort', forward);
    }
    // Sleep/wake detection: if wall-clock jumped far beyond expected sleep, reset retry backoff.
    const elapsed = Date.now() - started;
    if (elapsed > seconds * 1000 + SLEEP_JUMP_THRESHOLD_MS) {
      failures = 0;
    }
  };

  // The turns that run: each is its own agent in its own directory. One that throws is said, and the rest go on.
  const running = new Set<Promise<void>>();
  const start = (turn: ConnectorTurn): void => {
    const work = options.work(turn).catch((error: unknown) => {
      options.say(
        `A turn could not be run: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    running.add(work);
    void work.finally(() => running.delete(work));
  };

  let ended: 'stopped' | 'signed_out' = 'stopped';
  setState('connecting');
  while (!options.signal.aborted) {
    if (paused) {
      await sleepInterruptible(5);
      continue;
    }
    // With all slots full, wait until one finishes OR shutdown/pause fires.
    if (running.size >= limit) {
      let removeAbort: (() => void) | undefined;
      const aborted = new Promise<void>(resolve => {
        if (options.signal.aborted) return resolve();
        const done = (): void => resolve();
        options.signal.addEventListener('abort', done, { once: true });
        removeAbort = () => options.signal.removeEventListener('abort', done);
      });
      await Promise.race([...running, aborted]);
      removeAbort?.();
      continue;
    }
    let answer: Answer;
    try {
      const token = renewalDue
        ? await options.session.renew()
        : await options.session.accessToken();
      if (renewalDue) renewedWithoutSuccess = true;
      renewalDue = false;
      const body = described ? {} : { description: await options.describe() };
      answer = await ask(options.api, token, body, options.signal);
    } catch (error) {
      if (options.signal.aborted) break;
      if (error instanceof SignedOut) {
        ended = 'signed_out';
        break;
      }
      answer = {
        kind: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    if (options.signal.aborted) break;
    if (answer.kind === 'token_refused') {
      // One renewal. A new token that is refused too means the sign-in is over.
      if (renewedWithoutSuccess) {
        ended = 'signed_out';
        break;
      }
      renewalDue = true;
      continue;
    }
    if (answer.kind === 'describe') {
      described = false;
      continue;
    }
    if (answer.kind === 'work') {
      described = true;
      renewedWithoutSuccess = false;
      failures = 0;
      setState(paused ? 'paused' : 'connected');
      say('Connected.');
      options.onPoll?.({
        latencyMs: answer.latencyMs,
        hasTurn: answer.turn !== null,
        pollAfterSeconds: answer.pollAfterSeconds,
      });
      if (answer.unreadable)
        say('CoRoid sent work this connector cannot read. It was left alone.');
      if (answer.turn) {
        // The next may be waiting already (a Developer's explorer): ask again at once.
        start(answer.turn);
        continue;
      }
      await sleepInterruptible(answer.pollAfterSeconds);
      continue;
    }
    if (answer.kind === 'not_served') {
      setState('not_served', answer.reason);
      say(`CoRoid is not serving this machine: ${answer.reason}`);
      await sleepInterruptible(NOT_SERVED_RETRY_SECONDS);
      continue;
    }
    failures += 1;
    setState('reconnecting', answer.reason);
    say(`CoRoid could not be reached (${answer.reason}). Trying again.`);
    await sleepInterruptible(
      Math.min(FIRST_RETRY_SECONDS * 2 ** (failures - 1), LONGEST_RETRY_SECONDS)
    );
  }
  setState('stopping');
  // A turn that still runs is not dropped: it ends as CoRoid or its time limit says.
  await Promise.allSettled([...running]);
  return ended;
}

const waitMs = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Tells CoRoid what happened in a turn and returns what CoRoid wants next.
 * A token CoRoid no longer takes is renewed once. Transient network or 5xx
 * blips retry briefly so a long turn is not lost to a momentary drop. A turn
 * CoRoid does not know any more is over: the agent's session is to end.
 */
export async function reportTurn(
  api: string,
  session: Session,
  turnId: string,
  events: ConnectorTurnEvent[],
  options: { retryDelayMs?: number } = {}
): Promise<ConnectorTurnDirective> {
  const retryDelay = options.retryDelayMs ?? 1_000;
  const send = async (token: string): Promise<Response> =>
    fetch(`${api}/connector/v1/turns/${encodeURIComponent(turnId)}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= REPORT_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await send(await session.accessToken());
      if (response.status === 401) response = await send(await session.renew());
    } catch (error) {
      if (error instanceof SignedOut) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < REPORT_RETRIES) {
        await waitMs(retryDelay * attempt);
        continue;
      }
      throw lastError;
    }
    if (response.status === 401) throw new SignedOut();
    if (
      response.status === 404 ||
      response.status === 409 ||
      response.status === 410
    )
      return { action: 'end' };
    if (response.status >= 500 && attempt < REPORT_RETRIES) {
      lastError = new Error(
        `CoRoid did not take the turn's report (status ${response.status})`
      );
      await waitMs(retryDelay * attempt);
      continue;
    }
    if (!response.ok)
      throw new Error(
        `CoRoid did not take the turn's report (status ${response.status})`
      );
    const body = safeParseJson(await response.text());
    return parseConnectorTurnDirective(body);
  }
  throw lastError ?? new Error("CoRoid did not take the turn's report");
}
