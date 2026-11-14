import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalAgentModels, LocalAgentReport } from './protocol/local-agents.js';
import { AcpFailure, startAgent } from './acp.js';
import { modelSetting, reportedModels } from './agent-models.js';
import type { AgentProfile } from './agent-profiles.js';

const AUTH_REQUIRED = -32000;
const firstLine = (message: string): string => message.split('\n')[0].trim().slice(0, 300);
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Finds out whether an agent is there and signed in, and which models its
 * session offers, without a model request: it is started with its profile's
 * switch, in a new empty directory, and asked to open a session. Then it is
 * stopped and the directory removed.
 */
export async function probeAgent(
  profile: AgentProfile,
  options: { timeoutMs?: number; started?: (pid: number) => void } = {}
): Promise<LocalAgentReport> {
  // An agent whose adapter is not added is not started: nothing is downloaded to start it.
  if (!profile.command) {
    return { id: profile.id, version: null, tried: false, state: 'not_working', detail: `Not added: run coroid-connector add ${profile.id}`, models: null };
  }
  const command = profile.command;
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coroid-connector-')));
  // The check gives the agent no MCP server; the switch is set as for a turn, so that nothing of the person's loads.
  const switched = profile.ownToolsOff('coroid');
  for (const [name, content] of Object.entries(switched.files ?? {})) writeFileSync(join(directory, name), content);
  const agent = startAgent(command, { cwd: directory, env: switched.env });
  if (agent.pid !== null) options.started?.(agent.pid);

  let version: string | null = null;
  let models: LocalAgentModels | null = null;
  const report = (state: LocalAgentReport['state'], detail: string | null): LocalAgentReport => ({
    id: profile.id,
    version,
    tried: version !== null && profile.tried(version),
    state,
    detail,
    models,
  });
  try {
    const hello = await agent.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
      // A first start through npx downloads the adapter.
      options.timeoutMs ?? 120_000
    );
    version = isRecord(hello.agentInfo) ? text(hello.agentInfo.version) : null;
    const session = await agent.request(
      'session/new',
      { cwd: directory, mcpServers: [], ...(switched.sessionMeta ? { _meta: switched.sessionMeta } : {}) },
      options.timeoutMs ?? 60_000
    );
    const setting = modelSetting(session);
    models = setting ? { current: setting.current, offered: reportedModels(setting.offered) } : null;
    return report('ready', null);
  } catch (error) {
    if (!(error instanceof AcpFailure)) throw error;
    const needsSignIn = error.code === AUTH_REQUIRED || /\b(sign|log) ?in\b|authenticat/i.test(error.message);
    return report(needsSignIn ? 'sign_in_needed' : 'not_working', firstLine(error.message));
  } finally {
    await agent.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
