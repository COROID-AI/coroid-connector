import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConnectorTurn,
  ConnectorTurnDirective,
  ConnectorTurnEvent,
} from './protocol/local-agents.js';
import { AcpFailure, startAgent } from './acp.js';
import { putOnModel } from './agent-models.js';
import type { AgentProfile } from './agent-profiles.js';
import { isCallToServer, permissionAnswer } from './permission.js';
import { writeSwitchFiles } from './switch-files.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const nonNegInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;

const CANCEL_GRACE_MS = 300;
/** A timer may fire a moment before the wall clock reaches the deadline it was set for. */
const DEADLINE_SLACK_MS = 50;

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Optional live observer for UI telemetry and verbose logging during a turn. */
export interface TurnObserver {
  onActivity?(activity: string): void;
  onToolCall?(tool: string, allowed: boolean): void;
  onPermission?(tool: string, allowed: boolean): void;
  onUsage?(usage: TurnUsage): void;
  onMessage?(message: string): void;
  onStderr?(line: string): void;
}

/** Extracts input/output token counts from ACP `usage` payloads across agents. */
export function extractUsage(source: unknown): TurnUsage | null {
  if (!isRecord(source)) return null;
  const bag = isRecord(source.usage) ? source.usage : source;
  const input =
    nonNegInt(bag.inputTokens) ??
    nonNegInt(bag.input_tokens) ??
    nonNegInt(bag.promptTokens) ??
    nonNegInt(bag.prompt_tokens);
  const output =
    nonNegInt(bag.outputTokens) ??
    nonNegInt(bag.output_tokens) ??
    nonNegInt(bag.completionTokens) ??
    nonNegInt(bag.completion_tokens);
  if (input === null && output === null) return null;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/** What CoRoid is told when a turn fails: its time limit when that is what ended it, else the agent's failure in one line. */
export function failureReason(
  error: Error,
  now: number,
  deadline: number
): string {
  return now >= deadline - DEADLINE_SLACK_MS
    ? 'The turn’s time limit passed'
    : (error.message.split('\n')[0] ?? '').slice(0, 300);
}

/** Waits up to `ms`, settling immediately if `signal` aborts, with no leaked timer. */
function pauseWithCancel(
  ms: number,
  signal?: AbortSignal
): { promise: Promise<'paused' | 'aborted'>; cancel: () => void } {
  if (signal?.aborted)
    return { promise: Promise.resolve('aborted'), cancel: () => undefined };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  };
  const promise = new Promise<'paused' | 'aborted'>(resolve => {
    timer = setTimeout(() => {
      cancel();
      resolve('paused');
    }, ms);
    if (signal) {
      onAbort = () => {
        cancel();
        resolve('aborted');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return { promise, cancel };
}

/**
 * Runs one turn (Plan 47 Phase 4): one role's work, done by an agent on this
 * machine. The agent is started with its profile's switch in a new, empty
 * directory, and its session gets one MCP server: CoRoid's tools for this
 * turn, under a name made for this turn, so that no server of the person's
 * can pass for it. CoRoid hears what the agent says, and says when the turn
 * is over: an agent that stops by itself is not done until CoRoid agrees.
 *
 * A turn that names a model runs on that model or not at all (Phase 5b): an
 * agent that does not offer it, or does not change to it, fails the turn
 * before anything is asked of it, and CoRoid runs the role on its own model.
 *
 * When the turn is over the agent is stopped and the directory removed,
 * whatever happened.
 */
export async function runTurn(input: {
  turn: ConnectorTurn;
  profile: AgentProfile;
  /** Tells CoRoid what happened since the last report, and returns what CoRoid wants next. */
  report(events: ConnectorTurnEvent[]): Promise<ConnectorTurnDirective>;
  reportEveryMs?: number;
  started?: (pid: number) => void;
  signal?: AbortSignal;
  observer?: TurnObserver;
}): Promise<'ended' | 'failed'> {
  const { turn, profile, observer } = input;
  if (!profile.command) {
    await input.report([
      {
        type: 'failed',
        reason: `${profile.name} is not added on this machine`,
      },
    ]);
    return 'failed';
  }
  // Plan 48: an agent that may not be used on this machine is not started, though it was when the machine connected.
  const refusal = profile.refuses?.() ?? null;
  if (refusal) {
    await input.report([{ type: 'failed', reason: refusal }]);
    return 'failed';
  }
  const deadline = Date.now() + turn.timeLimitSeconds * 1000;
  const left = (): number => Math.max(deadline - Date.now(), 1);
  const server = `coroid_${randomBytes(6).toString('hex')}`;
  const switched = profile.ownToolsOff(server);
  const command = [...profile.command, ...(switched.args ?? [])];
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coroid-turn-')));
  writeSwitchFiles(directory, switched.files);
  switched.prepare?.();

  // What the agent has said and not yet been reported: fragments are joined into whole messages.
  const unsent: ConnectorTurnEvent[] = [];
  let saying = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastReportedInput = -1;
  let lastReportedOutput = -1;

  const recordUsage = (usage: TurnUsage, cumulative: boolean): void => {
    if (cumulative) {
      totalInputTokens = Math.max(totalInputTokens, usage.inputTokens);
      totalOutputTokens = Math.max(totalOutputTokens, usage.outputTokens);
    } else {
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
    }
    if (
      totalInputTokens !== lastReportedInput ||
      totalOutputTokens !== lastReportedOutput
    ) {
      lastReportedInput = totalInputTokens;
      lastReportedOutput = totalOutputTokens;
      unsent.push({
        type: 'usage',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });
      observer?.onUsage?.({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      });
    }
  };

  const endMessage = (): void => {
    if (saying.trim()) {
      unsent.push({ type: 'message', text: saying });
      observer?.onMessage?.(saying);
    }
    saying = '';
  };
  // Calls the agent reported, by id: some agents ask about a call by its id alone.
  const reported = new Map<
    string,
    { name: string | null; title: string | null; rawInput: unknown }
  >();

  observer?.onActivity?.('Starting agent…');
  const agent = startAgent(command, {
    cwd: directory,
    env: switched.env,
    listener: {
      notified: (method, params) => {
        if (method !== 'session/update' || !isRecord(params.update)) return;
        const update = params.update;
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          isRecord(update.content)
        ) {
          saying += text(update.content.text) ?? '';
          observer?.onActivity?.('Responding…');
        } else if (update.sessionUpdate === 'tool_call') {
          endMessage();
          const id = text(update.toolCallId);
          const name = text(update.name);
          const title = text(update.title);
          if (id) reported.set(id, { name, title, rawInput: update.rawInput });
          const allowed = isCallToServer(server, {
            name,
            title,
            rawInput: update.rawInput,
          });
          const label = name ?? title ?? 'tool';
          observer?.onToolCall?.(label, allowed);
          observer?.onActivity?.(
            allowed ? `Calling ${label}` : `Blocked ${label}`
          );
        } else if (
          update.sessionUpdate === 'usage_update' ||
          update.sessionUpdate === 'usage' ||
          update.sessionUpdate === 'token_usage'
        ) {
          const parsed = extractUsage(update);
          if (parsed) recordUsage(parsed, true);
        }
      },
      asked: (method, params) => {
        if (method !== 'session/request_permission') return undefined;
        const call = isRecord(params.toolCall) ? params.toolCall : {};
        const known = reported.get(text(call.toolCallId) ?? '');
        const name = text(call.name) ?? known?.name ?? null;
        const title = text(call.title) ?? known?.title ?? null;
        const allowed = isCallToServer(server, {
          name,
          title,
          rawInput: call.rawInput ?? known?.rawInput,
        });
        observer?.onPermission?.(name ?? title ?? 'unknown', allowed);
        return permissionAnswer(
          Array.isArray(params.options) ? params.options : [],
          allowed
        );
      },
      stderr: line => observer?.onStderr?.(line),
    },
  });
  if (agent.pid !== null) input.started?.(agent.pid);

  const tell = async (
    event?: ConnectorTurnEvent
  ): Promise<ConnectorTurnDirective> => {
    endMessage();
    if (event) unsent.push(event);
    return input.report(unsent.splice(0));
  };

  let sessionId: string | null = null;
  try {
    observer?.onActivity?.('Initializing ACP…');
    const hello = await agent.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      Math.min(left(), 120_000)
    );
    const capabilities = isRecord(hello.agentCapabilities)
      ? hello.agentCapabilities
      : {};
    const hasMcpCaps = isRecord(capabilities.mcpCapabilities);
    const mcp = hasMcpCaps
      ? (capabilities.mcpCapabilities as Record<string, unknown>)
      : {};
    const supportsHttp =
      mcp.http === true ||
      (profile.assumesHttpMcp === true && mcp.http !== false);
    if (!supportsHttp)
      throw new AcpFailure(
        `${profile.name} cannot use an MCP server over HTTP`
      );
    const takesSystemPrompt =
      isRecord(capabilities.sessionCapabilities) &&
      isRecord(capabilities.sessionCapabilities.systemPrompt);

    observer?.onActivity?.('Opening session…');
    const session = await agent.request(
      'session/new',
      {
        cwd: directory,
        mcpServers: [
          {
            type: 'http',
            name: server,
            url: turn.tools.url,
            headers: [
              { name: 'Authorization', value: `Bearer ${turn.tools.token}` },
            ],
          },
        ],
        ...(takesSystemPrompt
          ? {
              systemPrompt: {
                mode: 'append',
                content: [{ type: 'text', text: turn.rolePrompt }],
              },
            }
          : {}),
        ...(switched.sessionMeta ? { _meta: switched.sessionMeta } : {}),
      },
      Math.min(left(), 60_000)
    );
    sessionId = text(session.sessionId);
    if (!sessionId) throw new AcpFailure(`${profile.name} opened no session`);
    if (profile.mode)
      await agent.request(
        'session/set_mode',
        { sessionId, modeId: profile.mode },
        Math.min(left(), 60_000)
      );
    if (turn.model) {
      observer?.onActivity?.(`Setting model ${turn.model}…`);
      await putOnModel({
        agent,
        agentName: profile.name,
        session,
        sessionId,
        model: turn.model,
        timeoutMs: Math.min(left(), 60_000),
      });
    }

    let next = takesSystemPrompt
      ? turn.message
      : `${turn.rolePrompt}\n\n${turn.message}`;
    for (;;) {
      if (input.signal?.aborted) {
        await tell({
          type: 'failed',
          reason: 'The connector was stopped',
        }).catch(() => undefined);
        return 'failed';
      }
      observer?.onActivity?.('Thinking…');
      const asked = agent
        .request(
          'session/prompt',
          { sessionId, prompt: [{ type: 'text', text: next }] },
          left()
        )
        .then(result => ({
          stopped: text(result.stopReason) ?? 'stopped',
          usage: extractUsage(result),
        }));
      // While the agent works, CoRoid hears what it said so far, and may end the turn.
      let answer:
        | { stopped: string; usage: TurnUsage | null }
        | 'paused'
        | 'aborted' = 'paused';
      while (answer === 'paused') {
        const waiter = pauseWithCancel(
          input.reportEveryMs ?? 3_000,
          input.signal
        );
        answer = await Promise.race([asked, waiter.promise]);
        waiter.cancel();
        if (answer === 'aborted') {
          asked.catch(() => undefined);
          await tell({
            type: 'failed',
            reason: 'The connector was stopped',
          }).catch(() => undefined);
          return 'failed';
        }
        if (answer === 'paused' && (await tell()).action === 'end') {
          // The request is left unanswered on purpose: the agent is told to stop and then stopped.
          asked.catch(() => undefined);
          return 'ended';
        }
      }
      if (answer.usage) recordUsage(answer.usage, false);
      const directive = await tell({ type: 'stopped', reason: answer.stopped });
      if (directive.action !== 'say') return 'ended';
      next = directive.text;
    }
  } catch (error) {
    if (!(error instanceof AcpFailure)) throw error;
    const reason = failureReason(error, Date.now(), deadline);
    await tell({ type: 'failed', reason });
    return 'failed';
  } finally {
    if (sessionId) {
      // Told first, so that an agent that honours it ends its own work; then stopped either way.
      agent.notify('session/cancel', { sessionId });
      const grace = pauseWithCancel(CANCEL_GRACE_MS);
      await grace.promise;
    }
    await agent.stop();
    switched.cleanup?.();
    rmSync(directory, { recursive: true, force: true });
  }
}
