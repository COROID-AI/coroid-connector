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

/** How many turns run at once on one machine (Phase 5e, E6): the Developer's explorers run beside it. */
export const TURNS_AT_ONCE = 4;
const FIRST_RETRY_SECONDS = 5;
const LONGEST_RETRY_SECONDS = 60;
const NOT_SERVED_RETRY_SECONDS = 60;

type Session = { accessToken(): Promise<string>; renew(): Promise<string> };

type Answer =
  | { kind: 'work'; pollAfterSeconds: number; turn: ConnectorTurn | null; unreadable: boolean }
  | { kind: 'describe' }
  | { kind: 'token_refused' }
  | { kind: 'not_served'; reason: string }
  | { kind: 'failed'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

async function ask(api: string, token: string, body: unknown): Promise<Answer> {
  const response = await fetch(`${api}/connector/v1/poll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // An answer that is not JSON (a proxy's error page) is a failure like any other; its status says which.
  const raw = await response.text();
  const said: unknown = raw.trimStart().startsWith('{') ? JSON.parse(raw) : null;
  const record = isRecord(said) ? said : {};
  const reason = typeof record.error_description === 'string' ? record.error_description : `status ${response.status}`;
  if (response.status === 200) {
    const pace = record.pollAfterSeconds;
    const turn = record.turn == null ? null : parseConnectorTurn(record.turn);
    return {
      kind: 'work',
      pollAfterSeconds: typeof pace === 'number' && pace >= 1 && pace <= 300 ? pace : CONNECTOR_POLL_SECONDS,
      turn,
      unreadable: record.turn != null && turn === null,
    };
  }
  if (response.status === 409) return { kind: 'describe' };
  if (response.status === 401) return { kind: 'token_refused' };
  if (response.status === 403 || response.status === 503) return { kind: 'not_served', reason };
  return { kind: 'failed', reason };
}

/**
 * Keeps this machine connected: asks CoRoid for work at the pace CoRoid
 * names, which is also the machine's heartbeat. It describes the machine
 * until CoRoid has taken the description, and again when CoRoid asks. It
 * ends when it is told to stop, or when the machine's sign-in is over.
 */
export async function stayConnected(options: {
  api: string;
  session: Session;
  describe(): Promise<ConnectorDescription>;
  /** Runs a turn CoRoid handed over, to its end. Up to four run at once. */
  work(turn: ConnectorTurn): Promise<void>;
  /** Waits; returns early when `signal` fires. */
  sleep(seconds: number, signal: AbortSignal): Promise<void>;
  say(line: string): void;
  signal: AbortSignal;
}): Promise<'stopped' | 'signed_out'> {
  let described = false;
  let renewalDue = false;
  let renewedWithoutSuccess = false;
  let failures = 0;
  let lastSaid = '';
  const say = (line: string): void => {
    if (line !== lastSaid) options.say(line);
    lastSaid = line;
  };
  // The turns that run: each is its own agent in its own directory. One that throws is said, and the rest go on.
  const running = new Set<Promise<void>>();
  const start = (turn: ConnectorTurn): void => {
    const work = options.work(turn).catch((error: unknown) => {
      options.say(`A turn could not be run: ${error instanceof Error ? error.message : String(error)}`);
    });
    running.add(work);
    void work.finally(() => running.delete(work));
  };

  let ended: 'stopped' | 'signed_out' = 'stopped';
  while (!options.signal.aborted) {
    // With four turns running the next waits with CoRoid, which offers it elsewhere or to the model.
    if (running.size >= TURNS_AT_ONCE) {
      await Promise.race(running);
      continue;
    }
    let answer: Answer;
    try {
      const token = renewalDue ? await options.session.renew() : await options.session.accessToken();
      if (renewalDue) renewedWithoutSuccess = true;
      renewalDue = false;
      answer = await ask(options.api, token, described ? {} : { description: await options.describe() });
    } catch (error) {
      if (error instanceof SignedOut) {
        ended = 'signed_out';
        break;
      }
      answer = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }

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
      say('Connected.');
      if (answer.unreadable) say('CoRoid sent work this connector cannot read. It was left alone.');
      if (answer.turn) {
        // The next may be waiting already (a Developer's explorer): ask again at once.
        start(answer.turn);
        continue;
      }
      await options.sleep(answer.pollAfterSeconds, options.signal);
      continue;
    }
    if (answer.kind === 'not_served') {
      say(`CoRoid is not serving this machine: ${answer.reason}`);
      await options.sleep(NOT_SERVED_RETRY_SECONDS, options.signal);
      continue;
    }
    failures += 1;
    say(`CoRoid could not be reached (${answer.reason}). Trying again.`);
    await options.sleep(
      Math.min(FIRST_RETRY_SECONDS * 2 ** (failures - 1), LONGEST_RETRY_SECONDS),
      options.signal
    );
  }
  // A turn that still runs is not dropped: it ends as CoRoid or its time limit says.
  await Promise.allSettled([...running]);
  return ended;
}

/**
 * Tells CoRoid what happened in a turn and returns what CoRoid wants next.
 * A token CoRoid no longer takes is renewed once. A turn CoRoid does not
 * know any more is over: the agent's session is to end.
 */
export async function reportTurn(
  api: string,
  session: Session,
  turnId: string,
  events: ConnectorTurnEvent[]
): Promise<ConnectorTurnDirective> {
  const send = async (token: string): Promise<Response> =>
    fetch(`${api}/connector/v1/turns/${encodeURIComponent(turnId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  let response = await send(await session.accessToken());
  if (response.status === 401) response = await send(await session.renew());
  if (response.status === 401) throw new SignedOut();
  if (response.status === 404 || response.status === 409 || response.status === 410) return { action: 'end' };
  if (!response.ok) throw new Error(`CoRoid did not take the turn's report (status ${response.status})`);
  return parseConnectorTurnDirective(await response.json());
}
