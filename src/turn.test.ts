import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConnectorTurn,
  ConnectorTurnDirective,
  ConnectorTurnEvent,
} from './protocol/local-agents.js';
import type { AgentProfile } from './agent-profiles.js';
import { startFakeCoroid, type FakeCoroid } from './test-utils/fake-coroid.js';
import { failureReason, runTurn } from './turn.js';

/**
 * Plan 47 Phase 4: the connector runs one turn. It starts the agent with its
 * profile's switch, gives the session CoRoid's tools as its only MCP server,
 * hands over the role prompt and the first message, tells CoRoid what the
 * agent says, and ends the agent when CoRoid says so.
 *
 * Failure modes, written before the code:
 * U1  the agent is started in the directory the connector runs in, or
 *     without the profile's switch for this turn's server, or its mode is
 *     not set;
 * U2  the session does not get CoRoid's tools, gets them at another address
 *     or without the turn's token, or gets them under a name a server of the
 *     person's could also have;
 * U3  the role prompt is lost for an agent that takes no system prompt, or
 *     sent twice for one that does;
 * U4  during a turn a tool of the agent's own is allowed, or CoRoid's is
 *     refused;
 * U5  what the agent says reaches CoRoid in fragments, out of order, or not
 *     at all;
 * U6  CoRoid says the turn is over and the agent is left running;
 * U7  an agent that stops by itself ends the turn without CoRoid being
 *     asked, so a role without a verdict passes for finished; or what CoRoid
 *     then says is not put to the agent on the same session;
 * U8  the time limit passes and the agent goes on;
 * U9  an agent that cannot start, or cannot use an MCP server over HTTP,
 *     ends the connector instead of the turn;
 * U10 the turn's token is written where it outlives the turn (the session's
 *     directory is left behind).
 *
 * Phase 5b, a turn that names the model the agent is to use:
 * U11 the agent runs on its own model instead: the setting is not changed,
 *     is changed after the first message, or another setting is changed;
 * U12 a turn that names no model changes the agent's model;
 * U13 the agent does not offer the model, or offers no choice at all, and
 *     the turn runs anyway on whatever the agent is set to;
 * U14 the agent refuses the change, or answers it and stays on its model,
 *     and the turn runs anyway;
 * U15 a turn that ran out of time is reported as something else, because the
 *     agent's pending request timed out a moment before the deadline (a timer
 *     may fire a millisecond early by the wall clock).
 */
const STAND_IN = join(__dirname, 'test-utils', 'stand-in-agent.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'coroid-connector-turn-'));
const record = join(scratch, 'record.json');
const log = join(scratch, 'log.jsonl');
let coroid: FakeCoroid;

beforeEach(async () => {
  coroid = await startFakeCoroid();
  rmSync(record, { force: true });
  rmSync(log, { force: true });
});
afterEach(() => coroid.close());
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const profile = (mode: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'codex',
  name: 'Stand-in',
  command: [process.execPath, STAND_IN, '--mode', mode],
  ownToolsOff: server => ({
    env: { STAND_IN_RECORD: record, STAND_IN_LOG: log, STAND_IN_SWITCH: `only ${server}` },
    files: { 'stand-in.json': JSON.stringify({ only: server }) },
    sessionMeta: { standIn: { only: server } },
  }),
  mode: 'ask',
  switchedOffBy: 'the stand-in’s own switches',
  tried: () => true,
  ...extra,
});
const turn = (extra: Partial<ConnectorTurn> = {}): ConnectorTurn => ({
  id: 'turn-1',
  agent: 'codex',
  rolePrompt: 'You are the QA agent.',
  message: 'Verify the change and report your verdict.',
  tools: { url: `${coroid.api}/connector/v1/turns/turn-1/mcp`, token: coroid.turnToken },
  timeLimitSeconds: 30,
  model: null,
  ...extra,
});
const logged = (): Array<Record<string, unknown>> =>
  readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

/** Runs a turn; CoRoid answers each report with the next scripted directive, then "end" once the agent has stopped. */
async function run(mode: string, options: { turn?: Partial<ConnectorTurn>; profile?: Partial<AgentProfile>; directives?: ConnectorTurnDirective[] } = {}) {
  const reports: ConnectorTurnEvent[][] = [];
  const pids: number[] = [];
  const scripted = [...(options.directives ?? [])];
  const outcome = await runTurn({
    turn: turn(options.turn),
    profile: profile(mode, options.profile),
    reportEveryMs: 50,
    started: pid => pids.push(pid),
    report: async events => {
      reports.push(events);
      const stopped = events.some(event => event.type === 'stopped' || event.type === 'failed');
      return scripted.shift() ?? (stopped ? { action: 'end' } : { action: 'continue' });
    },
  });
  return { outcome, reports, events: reports.flat(), pids };
}

describe('the connector runs a turn', () => {
  it('U1, U2, U3, U5, U10: starts the agent switched, with CoRoid’s tools only, and tells CoRoid what it says', async () => {
    const { outcome, events, pids } = await run('ready');
    expect(outcome).toBe('ended');

    const seen = JSON.parse(readFileSync(record, 'utf8'));
    expect(seen.cwd).not.toBe(process.cwd());
    expect(seen.startedIn).toBe(seen.cwd);
    expect(seen.mcpServers).toHaveLength(1);
    const server = seen.mcpServers[0];
    expect(server).toEqual({
      type: 'http',
      name: expect.stringMatching(/^coroid_[0-9a-f]{12}$/),
      url: `${coroid.api}/connector/v1/turns/turn-1/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${coroid.turnToken}` }],
    });
    // The switch is the profile's, for this turn's server.
    expect(seen.switchInEnvironment).toBe(`only ${server.name}`);
    expect(seen.meta).toEqual({ standIn: { only: server.name } });
    expect(seen.filesInCwd).toEqual(['stand-in.json']);
    expect(seen.systemPrompt).toEqual({ mode: 'append', content: [{ type: 'text', text: 'You are the QA agent.' }] });

    const inside = logged();
    expect(inside).toContainEqual({ mode: 'ask' });
    expect(inside.filter(entry => 'prompt' in entry)).toEqual([{ prompt: 'Verify the change and report your verdict.' }]);
    expect(inside).toContainEqual({ listed: ['read_file', 'report_qa_verdict'] });
    expect(coroid.toolRequests.filter(request => request.method === 'tools/call').map(request => [request.name, request.token])).toEqual([
      ['read_file', coroid.turnToken],
      ['report_qa_verdict', coroid.turnToken],
    ]);

    // Whole messages, in the order they were said, then that the agent stopped.
    expect(events).toEqual([
      { type: 'message', text: 'Reading the change.' },
      { type: 'message', text: 'The verdict is PASS.' },
      { type: 'stopped', reason: 'end_turn' },
    ]);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0])).toBe(false);
    // U10: nothing of the turn is left on the machine.
    expect(() => readFileSync(join(seen.cwd, 'stand-in.json'))).toThrow();
  });

  it('U3: an agent that takes no system prompt gets the role prompt before its first message', async () => {
    await run('no-system-prompt');
    const seen = JSON.parse(readFileSync(record, 'utf8'));
    expect(seen.systemPrompt).toBeNull();
    expect(logged().filter(entry => 'prompt' in entry)).toEqual([
      { prompt: 'You are the QA agent.\n\nVerify the change and report your verdict.' },
    ]);
  });

  it('U4: an agent that asks is allowed CoRoid’s tools and refused its own', async () => {
    const { outcome } = await run('asks');
    expect(outcome).toBe('ended');
    const inside = logged();
    expect(inside.filter(entry => 'called' in entry).map(entry => entry.called)).toEqual(['read_file', 'report_qa_verdict']);
    expect(inside.filter(entry => 'refused' in entry)).toEqual([]);
    expect(inside).toContainEqual({ ownToolAllowed: false });
  });

  it('U7: an agent that stops is put what CoRoid says, on the same session, until CoRoid ends the turn', async () => {
    const { outcome, events } = await run('forgets', {
      directives: [{ action: 'say', text: 'You have not reported a verdict. Call report_qa_verdict now.' }],
    });
    expect(outcome).toBe('ended');
    expect(logged().filter(entry => 'prompt' in entry)).toEqual([
      { prompt: 'Verify the change and report your verdict.' },
      { prompt: 'You have not reported a verdict. Call report_qa_verdict now.' },
    ]);
    expect(events.filter(event => event.type === 'stopped')).toHaveLength(2);
    expect(coroid.toolRequests.filter(request => request.method === 'tools/call').map(request => request.name)).toContain('report_qa_verdict');
  });

  it('U6: when CoRoid ends the turn the agent is told to stop, and stopped', async () => {
    const { outcome, pids } = await run('slow', { directives: [{ action: 'continue' }, { action: 'end' }] });
    expect(outcome).toBe('ended');
    expect(alive(pids[0])).toBe(false);
    expect(logged()).toContainEqual({ cancelled: true });
  });

  it('U8: an agent that goes past the time limit is stopped, and CoRoid is told', async () => {
    const started = Date.now();
    const { outcome, events, pids } = await run('slow', { turn: { timeLimitSeconds: 0.4 } });
    expect(outcome).toBe('failed');
    expect(events.at(-1)).toEqual({ type: 'failed', reason: expect.stringMatching(/time limit/) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(alive(pids[0])).toBe(false);
  });

  it('U9: an agent that cannot start, or cannot reach CoRoid’s tools, fails the turn and not the connector', async () => {
    const missing = await run('ready', { profile: { command: ['coroid-no-such-agent-binary', 'acp'] } });
    expect(missing.outcome).toBe('failed');
    expect(missing.events).toEqual([{ type: 'failed', reason: expect.stringContaining('coroid-no-such-agent-binary') }]);

    const noHttp = await run('no-http');
    expect(noHttp.outcome).toBe('failed');
    expect(noHttp.events).toEqual([{ type: 'failed', reason: expect.stringMatching(/MCP server over HTTP/) }]);
    expect(coroid.toolRequests).toEqual([]);
    expect(alive(noHttp.pids[0])).toBe(false);
  });

  const offering = (...flags: string[]): Partial<AgentProfile> => ({
    command: [process.execPath, STAND_IN, '--mode', 'ready', ...flags],
  });
  const configured = (): unknown[] => logged().filter(entry => 'configured' in entry).map(entry => entry.configured);

  it('U11: a turn that names a model puts the agent on it before the first message', async () => {
    const { outcome } = await run('ready', {
      turn: { model: 'large' },
      profile: offering('--models', 'small,large', '--model-setting', 'llm'),
    });
    expect(outcome).toBe('ended');
    const inside = logged();
    // One change, of the model's setting, while nothing had been asked yet.
    expect(inside.filter(entry => 'configured' in entry)).toEqual([{ configured: { configId: 'llm', value: 'large' }, prompts: 0 }]);
    expect(inside.filter(entry => 'promptedOn' in entry)).toEqual([{ promptedOn: 'large' }]);
  });

  it('U11: a model that comes in a group is one the agent offers, and one it is already on needs no change', async () => {
    const grouped = await run('ready', { turn: { model: 'b/three' }, profile: offering('--models', 'a/one,a/two,b/three', '--grouped') });
    expect(grouped.outcome).toBe('ended');
    expect(logged().filter(entry => 'promptedOn' in entry)).toEqual([{ promptedOn: 'b/three' }]);

    rmSync(log, { force: true });
    const already = await run('ready', { turn: { model: 'large' }, profile: offering('--models', 'small,large', '--current-model', 'large') });
    expect(already.outcome).toBe('ended');
    expect(configured()).toEqual([]);
    expect(logged().filter(entry => 'promptedOn' in entry)).toEqual([{ promptedOn: 'large' }]);
  });

  it('U12: a turn that names no model leaves the agent on the model its owner set', async () => {
    const { outcome } = await run('ready', { profile: offering('--models', 'small,large', '--current-model', 'large') });
    expect(outcome).toBe('ended');
    expect(configured()).toEqual([]);
    expect(logged().filter(entry => 'promptedOn' in entry)).toEqual([{ promptedOn: 'large' }]);
  });

  it('U13: a model the agent does not offer fails the turn before anything is asked of the agent', async () => {
    const notOffered = await run('ready', { turn: { model: 'huge' }, profile: offering('--models', 'small,large') });
    expect(notOffered.outcome).toBe('failed');
    expect(notOffered.events).toEqual([{ type: 'failed', reason: 'Stand-in does not offer the model huge on this machine' }]);
    expect(logged().filter(entry => 'prompt' in entry || 'configured' in entry)).toEqual([]);
    expect(coroid.toolRequests).toEqual([]);
    expect(alive(notOffered.pids[0])).toBe(false);

    const noChoice = await run('ready', { turn: { model: 'large' } });
    expect(noChoice.outcome).toBe('failed');
    expect(noChoice.events).toEqual([{ type: 'failed', reason: 'Stand-in does not offer the model large on this machine' }]);
    expect(coroid.toolRequests).toEqual([]);
  });

  it('U14: an agent that refuses the model, or stays on its own, fails the turn before anything is asked of it', async () => {
    const refuses = await run('refuses-model', {
      turn: { model: 'large' },
      profile: { command: [process.execPath, STAND_IN, '--mode', 'refuses-model', '--models', 'small,large'] },
    });
    expect(refuses.outcome).toBe('failed');
    expect(refuses.events).toEqual([{ type: 'failed', reason: expect.stringContaining('That model is not available.') }]);
    expect(logged().filter(entry => 'prompt' in entry)).toEqual([]);

    rmSync(log, { force: true });
    const ignores = await run('ignores-model', {
      turn: { model: 'large' },
      profile: { command: [process.execPath, STAND_IN, '--mode', 'ignores-model', '--models', 'small,large'] },
    });
    expect(ignores.outcome).toBe('failed');
    expect(ignores.events).toEqual([{ type: 'failed', reason: 'Stand-in did not change to the model large' }]);
    expect(logged().filter(entry => 'prompt' in entry)).toEqual([]);
    expect(coroid.toolRequests).toEqual([]);
  });

  it('U15: a request that times out at the deadline, or a moment before it, is the turn’s time limit', () => {
    const deadline = 1_000_000;
    const late = new Error('The agent did not answer session/prompt within 0 s');
    expect(failureReason(late, deadline + 1, deadline)).toBe('The turn’s time limit passed');
    expect(failureReason(late, deadline - 3, deadline)).toBe('The turn’s time limit passed');
    // Long before it, the agent's own failure is said, in one line.
    expect(failureReason(new Error('Codex refused\nmore'), deadline - 60_000, deadline)).toBe('Codex refused');
  });
});

