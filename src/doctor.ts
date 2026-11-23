import { homedir } from 'node:os';
import type { LocalAgentReport } from './protocol/local-agents.js';
import { formatModelName } from './agent-models.js';
import { agentProfiles, type AgentProfile } from './agent-profiles.js';
import { formatDuration, formatTimestamp } from './connector-state.js';
import { lockStatus } from './lock.js';
import { probeAgent } from './probe.js';
import { platformSecretStore } from './secret-store.js';
import { SignInStore } from './store.js';
import { VERSION } from './version.js';

export interface DoctorAgentResult {
  id: string;
  name: string;
  binary: string | null;
  report: LocalAgentReport;
  hint: string | null;
}

export interface DoctorReport {
  timestamp: string;
  connectorVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  api: string;
  apiReachable: boolean;
  apiLatencyMs: number | null;
  apiDetail: string | null;
  credentialStore: string;
  signedIn: boolean;
  accessTokenExpiresInMs: number | null;
  lock: { locked: boolean; pid: number | null };
  agents: DoctorAgentResult[];
}

export function agentHint(
  profile: AgentProfile,
  report: LocalAgentReport
): string | null {
  if (report.state === 'ready' && report.tried) return null;
  if (report.state === 'ready' && !report.tried) {
    return `Version ${report.version ?? 'unknown'} is not yet verified by connector ${VERSION}. Check for a connector update.`;
  }
  if (report.state === 'sign_in_needed') {
    if (profile.id === 'antigravity')
      return 'Sign in by running `agy` once in a terminal.';
    if (profile.id === 'cursor') return 'Sign in by running `agent login`.';
    if (profile.id === 'codex') return 'Sign in by running `codex login`.';
    if (profile.id === 'claude') return 'Sign in by running `claude login`.';
    return `Sign in to ${profile.name} on this machine, then run check again.`;
  }
  if (!profile.command) return `Run: coroid-connector add ${profile.id}`;
  if (profile.id === 'antigravity')
    return 'Install Antigravity CLI (`agy`) so it is in PATH or ~/.gemini/bin/agy.';
  if (profile.id === 'cursor')
    return (
      report.detail ?? 'Install Cursor CLI (`agent`) and run `agent login`.'
    );
  if (profile.id === 'opencode')
    return 'Install OpenCode (`opencode`) so it is in PATH.';
  return report.detail;
}

async function checkApiReachability(api: string): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  detail: string | null;
}> {
  const started = Date.now();
  for (const path of ['/.well-known/oauth-authorization-server', '/health']) {
    try {
      const response = await fetch(`${api}${path}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      const latencyMs = Date.now() - started;
      if (response.ok || response.status < 500) {
        return {
          reachable: true,
          latencyMs,
          detail: `HTTP ${response.status}`,
        };
      }
      return { reachable: false, latencyMs, detail: `HTTP ${response.status}` };
    } catch (error) {
      if (path === '/health') {
        return {
          reachable: false,
          latencyMs: null,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  return { reachable: false, latencyMs: null, detail: 'unreachable' };
}

export async function runDoctor(options: {
  api: string;
  file: string;
  home?: string;
}): Promise<DoctorReport> {
  const home = options.home ?? homedir();
  const profiles = agentProfiles(home);
  const store = new SignInStore(
    options.file,
    options.api,
    () => undefined,
    platformSecretStore()
  );
  const signedIn = store.read();
  const lock = lockStatus(`${options.file}.lock`);

  const [apiCheck, probed] = await Promise.all([
    checkApiReachability(options.api),
    Promise.all(
      profiles.map(async profile => {
        const report = await probeAgent(profile);
        const binary =
          profile.command &&
          profile.command[0] === process.execPath &&
          profile.command[1]
            ? profile.command[1]
            : (profile.command?.[0] ?? null);
        return {
          id: profile.id,
          name: profile.name,
          binary,
          report,
          hint: agentHint(profile, report),
        };
      })
    ),
  ]);

  return {
    timestamp: formatTimestamp(new Date()),
    connectorVersion: VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    api: options.api,
    apiReachable: apiCheck.reachable,
    apiLatencyMs: apiCheck.latencyMs,
    apiDetail: apiCheck.detail,
    credentialStore: store.where(),
    signedIn: signedIn !== null,
    accessTokenExpiresInMs: signedIn
      ? signedIn.accessTokenExpiresAt - Date.now()
      : null,
    lock,
    agents: probed,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const ok = (yes: boolean): string => (yes ? '✓' : '✗');
  lines.push(
    `CoRoid Connector v${report.connectorVersion} — Diagnostics (${report.timestamp})`
  );
  lines.push('─'.repeat(72));
  lines.push(
    `  Runtime      : Node ${report.nodeVersion} (${report.platform}/${report.arch})`
  );
  lines.push(
    `  API endpoint : ${ok(report.apiReachable)} ${report.api}` +
      (report.apiLatencyMs !== null
        ? ` (${report.apiLatencyMs}ms, ${report.apiDetail ?? 'ok'})`
        : ` (${report.apiDetail ?? 'unreachable'})`)
  );
  const authSummary = report.signedIn
    ? `signed in (${report.credentialStore}` +
      (report.accessTokenExpiresInMs !== null &&
      report.accessTokenExpiresInMs > 0
        ? `, token valid ${formatDuration(report.accessTokenExpiresInMs)}`
        : ', token will refresh on connect') +
      ')'
    : `not signed in (will store in ${report.credentialStore})`;
  lines.push(`  Auth         : ${ok(report.signedIn)} ${authSummary}`);
  lines.push(
    `  Process lock : ${report.lock.locked ? `active (PID ${report.lock.pid})` : 'free (no connector running for this sign-in)'}`
  );
  lines.push('');
  lines.push('Detected Coding Tools:');
  for (const agent of report.agents) {
    const r = agent.report;
    const badge =
      r.state === 'ready' && r.tried
        ? '✓ ready'
        : r.state === 'ready'
          ? '⚠ untried'
          : r.state === 'sign_in_needed'
            ? '! sign-in needed'
            : '✗ unavailable';
    const ver = r.version ? `v${r.version}` : '—';
    const models = r.models?.current
      ? `${formatModelName(r.models.current, r.models.labels)} (${r.models.offered.length} models)`
      : r.models
        ? `${r.models.offered.length} models`
        : '';
    lines.push(
      `  ${agent.name.padEnd(13)} ${badge.padEnd(17)} ${ver.padEnd(20)} ${models}`
    );
    if (agent.binary) lines.push(`                path: ${agent.binary}`);
    if (r.detail) lines.push(`                info: ${r.detail}`);
    if (agent.hint && agent.hint !== r.detail)
      lines.push(`                hint: ${agent.hint}`);
  }
  const readyCount = report.agents.filter(
    a => a.report.state === 'ready' && a.report.tried
  ).length;
  lines.push('─'.repeat(72));
  lines.push(
    `Summary: ${readyCount}/${report.agents.length} coding tool(s) ready for CoRoid turns.`
  );
  return lines.join('\n');
}
