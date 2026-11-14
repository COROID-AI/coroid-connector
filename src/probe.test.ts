import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from './agent-profiles.js';
import { ADAPTERS } from './agent-install.js';
import { AGENT_PROFILES } from './agent-profiles.js';
import { probeAgent } from './probe.js';

/**
 * Plan 47 Phase 3: what the connector says about each coding agent on the
 * machine. It starts the agent and opens a session, without a model request.
 *
 * Failure modes, written before the code:
 * A1 an agent that asks for a sign-in is reported ready;
 * A2 an agent that is not installed, ends at once or refuses a session for
 *    another reason ends the connector, or is reported ready;
 * A3 an agent that never answers keeps the connector waiting for ever, or is
 *    left running;
 * A4 a version the profile was not tried on is reported as tried;
 * A5 the probe opens the session in the directory the connector runs in, or
 *    without the profile's switch for the agent's own tools, so a mere check
 *    starts an agent with the person's files and tools in reach;
 * A6 the agent is still running after a probe that succeeded;
 * A7 a profile ships without a switch for its agent's own tools;
 * A8 an agent gives up on a call to CoRoid's tools before the tool can end
 *    (Claude Code by itself waits about a minute; a build or the tests run
 *    through `exec_command` for up to 30 minutes);
 * A9 (Plan 48c) Claude Code keeps a transcript of a turn in the person's home
 *    directory.
 *
 * Phase 5b, the agent's own models (what a session's settings offer):
 * B1 the models are not reported, or another setting's values (the mode's,
 *    the effort's) are reported as models;
 * B2 models that come in groups are lost, or out of order;
 * B3 a setting that says what it is only by its id, or only by its
 *    category, is not found;
 * B4 an agent whose session offers no choice of model is reported as not
 *    working, or as offering an empty list;
 * B5 an agent with thousands of models makes the machine's description a
 *    request too large for CoRoid to take, so the machine never connects.
 */
const STAND_IN = join(__dirname, 'test-utils', 'stand-in-agent.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'coroid-connector-probe-'));
const record = join(scratch, 'record.json');

const profile = (mode: string, extra: Partial<AgentProfile> = {}, version = '2.2.7'): AgentProfile => ({
  id: 'opencode',
  name: 'Stand-in',
  command: [process.execPath, STAND_IN, '--mode', mode, '--version', version],
  ownToolsOff: () => ({
    env: { STAND_IN_RECORD: record, STAND_IN_SWITCH: 'own-tools-off' },
    files: { 'stand-in.json': '{"ownTools":false}' },
    sessionMeta: { standIn: { ownTools: false } },
  }),
  switchedOffBy: 'the stand-in’s own switches',
  tried: found => found.startsWith('2.2.'),
  ...extra,
});
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
};

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('what the connector finds out about an agent', () => {
  it('A5, A6: opens a session in a new, empty directory with the profile’s switch, and stops the agent', async () => {
    const pids: number[] = [];
    const report = await probeAgent(profile('ready'), { started: pid => pids.push(pid) });
    expect(report).toEqual({ id: 'opencode', version: '2.2.7', tried: true, state: 'ready', detail: null, models: null });

    const seen = JSON.parse(readFileSync(record, 'utf8'));
    expect(seen.cwd).not.toBe(process.cwd());
    expect(seen.startedIn).toBe(seen.cwd);
    expect(seen.filesInCwd).toEqual(['stand-in.json']);
    expect(seen.mcpServers).toEqual([]);
    expect(seen.meta).toEqual({ standIn: { ownTools: false } });
    expect(seen.switchInEnvironment).toBe('own-tools-off');
    expect(existsSync(seen.cwd)).toBe(false);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0])).toBe(false);
  });

  it('A1: an agent that asks for a sign-in needs one', async () => {
    expect(await probeAgent(profile('sign-in'))).toEqual({
      id: 'opencode', version: '2.2.7', tried: true, state: 'sign_in_needed', detail: 'Authentication required', models: null,
    });
  });

  it('A2: an agent that is missing, ends at once or refuses a session is not working, and says why in one line', async () => {
    expect(await probeAgent(profile('broken'))).toEqual({
      id: 'opencode', version: '2.2.7', tried: true, state: 'not_working', detail: 'This client is no longer supported.', models: null,
    });
    const missing = await probeAgent(profile('ready', { command: ['coroid-no-such-agent-binary', 'acp'] }));
    expect(missing).toMatchObject({ version: null, tried: false, state: 'not_working' });
    expect(missing.detail).toContain('coroid-no-such-agent-binary');
    const exits = await probeAgent(profile('exits'));
    expect(exits).toMatchObject({ version: null, tried: false, state: 'not_working' });
    expect(exits.detail).toMatch(/ended/);
  });

  it('A3: an agent that never answers is given up on, and stopped', async () => {
    const pids: number[] = [];
    const started = Date.now();
    const report = await probeAgent(profile('silent'), { timeoutMs: 400, started: pid => pids.push(pid) });
    expect(report).toMatchObject({ version: null, state: 'not_working' });
    expect(report.detail).toMatch(/did not answer/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(pids[0])).toBe(false);
  });

  it('A4: a version the profile was not tried on is said to be untried', async () => {
    expect(await probeAgent(profile('ready', {}, '3.0.0'))).toEqual({
      id: 'opencode', version: '3.0.0', tried: false, state: 'ready', detail: null, models: null,
    });
  });

  const offering = (...flags: string[]): AgentProfile => {
    const base = profile('ready');
    return { ...base, command: [...(base.command ?? []), ...flags] };
  };

  it('B1: reports the models of the session’s model setting and the one it is on, not another setting’s values', async () => {
    const report = await probeAgent(offering('--models', 'small,large,huge', '--current-model', 'large'));
    expect(report).toMatchObject({ state: 'ready', detail: null });
    expect(report.models).toEqual({ current: 'large', offered: ['small', 'large', 'huge'] });
  });

  it('B2: models that come in groups are reported as one list, in the agent’s order', async () => {
    const report = await probeAgent(offering('--models', 'a/one,a/two,b/three', '--grouped'));
    expect(report.models).toEqual({ current: 'a/one', offered: ['a/one', 'a/two', 'b/three'] });
  });

  it('B3: the setting is found by its category under another id, and by its id without a category', async () => {
    const byCategory = await probeAgent(offering('--models', 'small,large', '--model-setting', 'llm'));
    expect(byCategory.models).toEqual({ current: 'small', offered: ['small', 'large'] });
    const byId = await probeAgent(offering('--models', 'small,large', '--model-category', 'none'));
    expect(byId.models).toEqual({ current: 'small', offered: ['small', 'large'] });
  });

  it('B4: an agent whose session offers no choice of model is ready, and says nothing about models', async () => {
    const report = await probeAgent(offering());
    expect(report).toMatchObject({ state: 'ready', models: null });
  });

  it('B5: of thousands of models the report keeps the first ones, and stays a small request', async () => {
    const report = await probeAgent(offering('--many-models', '3000'));
    expect(report.state).toBe('ready');
    expect(report.models?.current).toBe(`provider-0/${'m'.repeat(90)}`);
    expect(report.models?.offered.slice(0, 2)).toEqual([`provider-0/${'m'.repeat(90)}`, `provider-1/${'m'.repeat(90)}`]);
    // Three such reports and the rest of a description fit the 100 kB a request to CoRoid may be.
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(32_000);
    expect(report.models?.offered.length).toBeGreaterThan(100);
  });

  it('A8: Claude Code waits for a tool call longer than exec_command may run', () => {
    const claude = AGENT_PROFILES.find(known => known.id === 'claude');
    const env = claude?.ownToolsOff('coroid_0123456789ab').env ?? {};
    expect(Number(env.MCP_TOOL_TIMEOUT)).toBeGreaterThan(30 * 60_000);
  });

  it('A9: Claude Code keeps no transcript of a turn', () => {
    const claude = AGENT_PROFILES.find(known => known.id === 'claude');
    expect(claude?.ownToolsOff('coroid_0123456789ab').sessionMeta).toMatchObject({ claudeCode: { options: { persistSession: false } } });
  });

  it('A7: every profile switches its agent’s own tools off, and names the versions it was tried on', () => {
    expect(AGENT_PROFILES.map(known => known.id).sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const known of AGENT_PROFILES) {
      const switched = known.ownToolsOff('coroid_0123456789ab');
      expect([known.id, Object.keys(switched).length > 0]).toEqual([known.id, true]);
      expect(known.switchedOffBy).toMatch(/\S+ \S+/);
      expect(known.tried('0.0.0-not-a-tried-version')).toBe(false);
    }
    const tried = Object.fromEntries(AGENT_PROFILES.map(known => [known.id, known]));
    expect(tried.claude.tried('0.106.0')).toBe(true);
    expect(tried.codex.tried('2.6.0')).toBe(true);
    expect(tried.opencode.tried('2.2.7')).toBe(true);
    // Claude and Codex are installed at the adapter version that was tried (Plan 48a), not at whatever is newest.
    expect(ADAPTERS.claude.manifest.dependencies).toEqual({ '@agentclientprotocol/claude-agent-acp': '0.106.0' });
    expect(ADAPTERS.codex.manifest.dependencies).toEqual({ '@agentclientprotocol/codex-acp': '2.6.0' });
  });
});
