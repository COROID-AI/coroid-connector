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
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const pause = (ms: number): Promise<'paused'> => new Promise(resolve => setTimeout(() => resolve('paused'), ms));
const CANCEL_GRACE_MS = 300;
/** A timer may fire a moment before the wall clock reaches the deadline it was set for. */
const DEADLINE_SLACK_MS = 50;

/** What CoRoid is told when a turn fails: its time limit when that is what ended it, else the agent's failure in one line. */
export function failureReason(error: Error, now: number, deadline: number): string {
  return now >= deadline - DEADLINE_SLACK_MS ? 'The turn’s time limit passed' : (error.message.split('\n')[0] ?? '').slice(0, 300);
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
 * whatever happened. What an agent keeps of the turn in its own storage is
 * the agent's (Plan 48c): Claude Code keeps no transcript (`persistSession:
 * false`); Codex and OpenCode keep theirs, in `~/.codex/sessions` and in
 * OpenCode's database.
 */
export async function runTurn(input: {
  turn: ConnectorTurn;
  profile: AgentProfile;
  /** Tells CoRoid what happened since the last report, and returns what CoRoid wants next. */
  report(events: ConnectorTurnEvent[]): Promise<ConnectorTurnDirective>;
  reportEveryMs?: number;
  started?: (pid: number) => void;
}): Promise<'ended' | 'failed'> {
  const { turn, profile } = input;
  if (!profile.command) {
    await input.report([{ type: 'failed', reason: `${profile.name} is not added on this machine` }]);
    return 'failed';
  }
  // Plan 48: an agent that may not be used on this machine is not started, though it was when the machine connected.
  const refusal = profile.refuses?.() ?? null;
  if (refusal) {
    await input.report([{ type: 'failed', reason: refusal }]);
    return 'failed';
  }
  const command = profile.command;
  const deadline = Date.now() + turn.timeLimitSeconds * 1000;
  const left = (): number => Math.max(deadline - Date.now(), 1);
  const server = `coroid_${randomBytes(6).toString('hex')}`;
  const switched = profile.ownToolsOff(server);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coroid-turn-')));
  writeSwitchFiles(directory, switched.files);

  // What the agent has said and not yet been reported: fragments are joined into whole messages.
  const unsent: ConnectorTurnEvent[] = [];
  let saying = '';
  const endMessage = (): void => {
    if (saying.trim()) unsent.push({ type: 'message', text: saying });
    saying = '';
  };
  // Calls the agent reported, by id: some agents ask about a call by its id alone.
  const reported = new Map<string, { title: string | null; rawInput: unknown }>();

  const agent = startAgent(command, {
    cwd: directory,
    env: switched.env,
    listener: {
      notified: (method, params) => {
        if (method !== 'session/update' || !isRecord(params.update)) return;
        const update = params.update;
        if (update.sessionUpdate === 'agent_message_chunk' && isRecord(update.content)) {
          saying += text(update.content.text) ?? '';
        } else if (update.sessionUpdate === 'tool_call') {
          endMessage();
          const id = text(update.toolCallId);
          if (id) reported.set(id, { title: text(update.title), rawInput: update.rawInput });
        }
      },
      asked: (method, params) => {
        if (method !== 'session/request_permission') return undefined;
        const call = isRecord(params.toolCall) ? params.toolCall : {};
        const known = reported.get(text(call.toolCallId) ?? '');
        const allowed = isCallToServer(server, {
          title: text(call.title) ?? known?.title ?? null,
          rawInput: call.rawInput ?? known?.rawInput,
        });
        return permissionAnswer(Array.isArray(params.options) ? params.options : [], allowed);
      },
    },
  });
  if (agent.pid !== null) input.started?.(agent.pid);

  const tell = async (event?: ConnectorTurnEvent): Promise<ConnectorTurnDirective> => {
    endMessage();
    if (event) unsent.push(event);
    return input.report(unsent.splice(0));
  };

  let sessionId: string | null = null;
  try {
    const hello = await agent.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
      Math.min(left(), 120_000)
    );
    const capabilities = isRecord(hello.agentCapabilities) ? hello.agentCapabilities : {};
    const mcp = isRecord(capabilities.mcpCapabilities) ? capabilities.mcpCapabilities : {};
    if (mcp.http !== true) throw new AcpFailure(`${profile.name} cannot use an MCP server over HTTP`);
    const takesSystemPrompt =
      isRecord(capabilities.sessionCapabilities) && isRecord(capabilities.sessionCapabilities.systemPrompt);

    const session = await agent.request(
      'session/new',
      {
        cwd: directory,
        mcpServers: [
          {
            type: 'http',
            name: server,
            url: turn.tools.url,
            headers: [{ name: 'Authorization', value: `Bearer ${turn.tools.token}` }],
          },
        ],
        ...(takesSystemPrompt
          ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: turn.rolePrompt }] } }
          : {}),
        ...(switched.sessionMeta ? { _meta: switched.sessionMeta } : {}),
      },
      Math.min(left(), 60_000)
    );
    sessionId = text(session.sessionId);
    if (!sessionId) throw new AcpFailure(`${profile.name} opened no session`);
    if (profile.mode) await agent.request('session/set_mode', { sessionId, modeId: profile.mode }, Math.min(left(), 60_000));
    if (turn.model) {
      await putOnModel({ agent, agentName: profile.name, session, sessionId, model: turn.model, timeoutMs: Math.min(left(), 60_000) });
    }

    let next = takesSystemPrompt ? turn.message : `${turn.rolePrompt}\n\n${turn.message}`;
    for (;;) {
      const asked = agent
        .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: next }] }, left())
        .then(result => ({ stopped: text(result.stopReason) ?? 'stopped' }));
      // While the agent works, CoRoid hears what it said so far, and may end the turn.
      let answer: { stopped: string } | 'paused' = 'paused';
      while (answer === 'paused') {
        answer = await Promise.race([asked, pause(input.reportEveryMs ?? 3_000)]);
        if (answer === 'paused' && (await tell()).action === 'end') {
          // The request is left unanswered on purpose: the agent is told to stop and then stopped.
          asked.catch(() => undefined);
          return 'ended';
        }
      }
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
      await pause(CANCEL_GRACE_MS);
    }
    await agent.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
