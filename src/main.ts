import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import type {
  ConnectorDescription,
  ConnectorTurnDirective,
  ConnectorTurnEvent,
  LocalAgentReport,
} from './protocol/local-agents.js';
import { addAgent, isAddableAgent } from './agent-install.js';
import { formatModelName } from './agent-models.js';
import { agentProfiles } from './agent-profiles.js';
import { parseCliArgs, type ParsedCliArgs } from './cli-args.js';
import {
  reportTurn,
  stayConnected,
  type ConnectionControl,
} from './connect.js';
import {
  ConnectorState,
  formatDuration,
  formatTimestamp,
  formatTokens,
  type AgentSnapshot,
  type InteractiveCommand,
} from './connector-state.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { holdLock } from './lock.js';
import { probeAgent } from './probe.js';
import { platformSecretStore } from './secret-store.js';
import { Session } from './session.js';
import { signIn } from './sign-in.js';
import { SignInStore, storeFileFor, storeFileIn } from './store.js';
import { runTurn } from './turn.js';
import { ConnectorUI } from './ui.js';
import { VERSION } from './version.js';

const USAGE = `coroid-connector ${VERSION}

Connects this machine to CoRoid, so that coding agents on it can do work
CoRoid assigns to them. The agents get CoRoid's tools and nothing of this
machine. CoRoid gets no access to files or programs here.

Usage:
  coroid-connector [run] [options]
      Signs in (once, in your browser), launches the live terminal UI, and
      stays connected until you stop it (runs up to 4 parallel turns by default).
  coroid-connector status [--api <address>] [--json]
      Checks detected coding tools, models, and sign-in status.
  coroid-connector doctor [--api <address>] [--json]
      Runs full diagnostics (runtime, API reachability, auth, lock, all tools).
  coroid-connector add codex|claude
      Installs the release-locked ACP adapter (~350 MB) into ~/.coroid/connector/agents.
      OpenCode, Cursor, and Antigravity (agy) use your local installation directly.
  coroid-connector logout [--api <address>]
      Forgets this machine's sign-in and revokes its token.

Options:
  --api <address>      CoRoid API address (default: https://api.coroid.ai)
  --name <name>        Machine name shown in CoRoid (default: hostname)
  --concurrency <1-8>  Maximum parallel turns on this machine (default: 4)
  --verbose, -v        Start with verbose logging (polls, tools, permissions, stderr)
  --plain, --no-ui     Stream timestamped plain text logs instead of the interactive UI
  --json               Emit structured JSON (NDJSON for run, JSON object for status/doctor)
  --log-file <path>    Also append timestamped session logs to a file (mode 0600)
  --no-browser         Print the approval address instead of opening a browser
  --state-dir <dir>    Keep the sign-in there instead of ~/.coroid/connector
  --version, -V        Print the connector version
  --help, -h           Show this help

Interactive TUI controls (while running):
  ◀ ▶ + Enter  Select & run action bar (Check, Basic/Verbose, Pause, Clear, Menu, Quit)
  Esc          Open Control Menu (or return to Overview) · ↑↓ navigate · Enter run
  Tab / 1–5    Switch views (Overview, Agents Inspector, Stats, Logs, Help)
  Shortcuts    c check · v verbose · p pause · q / Ctrl+C quit
`;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** CoRoid's address: https, or a developer's own machine over http. */
function apiAddress(given: string | undefined): string | null {
  const address = given ?? 'https://api.coroid.ai';
  if (!URL.canParse(address)) return null;
  const url = new URL(address);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (url.protocol === 'http:' && local)
    ? url.origin
    : null;
}

function openInBrowser(url: string, start: boolean): void {
  say(
    start
      ? 'Approve this machine in CoRoid. If no browser opens, open this address:'
      : 'Approve this machine in CoRoid. Open this address in a browser on this machine:'
  );
  say(`  ${url}`);
  if (!start) return;
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  // No browser opener on this machine: the address is printed above.
  spawn(command, args, { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
}

/** What the check found of one agent, in a few words. */
function foundOf(agent: LocalAgentReport): string {
  if (agent.state === 'sign_in_needed') return 'needs you to sign in to it';
  if (agent.state !== 'ready') return 'not found or not working';
  const on = agent.models?.current
    ? `, on ${formatModelName(agent.models.current, agent.models.labels)}`
    : '';
  const count = agent.models?.offered.length
    ? ` (${agent.models.offered.length} models)`
    : '';
  return `ready${on}${count}${agent.tried ? '' : ', untried version — will not be used'}`;
}

async function probeAllAgents(
  home: string,
  state?: ConnectorState
): Promise<{ snapshots: AgentSnapshot[]; reports: LocalAgentReport[] }> {
  const profiles = agentProfiles(home);
  if (state) {
    state.setAgents(
      profiles.map(p => ({
        id: p.id,
        name: p.name,
        command: p.command,
        report:
          state.agents.find(existing => existing.id === p.id)?.report ?? null,
        checking: true,
      }))
    );
  }
  const reports = await Promise.all(
    profiles.map(profile => probeAgent(profile))
  );
  const checkedAt = Date.now();
  const snapshots: AgentSnapshot[] = profiles.map((p, index) => ({
    id: p.id,
    name: p.name,
    command: p.command,
    report: reports[index] ?? null,
    checking: false,
    checkedAt,
  }));
  state?.setAgents(snapshots);
  return { snapshots, reports };
}

const sleep = (seconds: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    signal.addEventListener('abort', done);
  });

async function runConnector(
  api: string,
  name: string,
  file: string,
  parsed: ParsedCliArgs
): Promise<number> {
  const store = new SignInStore(
    file,
    api,
    reason =>
      say(
        `[${formatTimestamp(new Date())}] The saved sign-in could not be used (${reason}); signing in again.`
      ),
    platformSecretStore(),
    line => say(`[${formatTimestamp(new Date())}] ${line}`)
  );
  const existing = store.read();
  if (!existing) {
    store.write(
      await signIn({
        api,
        machineName: name,
        open: url => openInBrowser(url, parsed.browser),
      })
    );
  }
  const lock = holdLock(`${file}.lock`);
  if (!lock) {
    say('A connector is already running for this sign-in on this machine.');
    return 1;
  }

  const state = new ConnectorState({
    version: VERSION,
    machineName: name,
    api,
    platform: process.platform,
    credentialStore: store.where(),
    maxConcurrency: parsed.concurrency,
    logLevel: parsed.verbose ? 'verbose' : 'basic',
  });

  const stop = new AbortController();
  const forceCancelTurns = new AbortController();
  let sigintCount = 0;
  let connectionControl: ConnectionControl | null = null;
  let rechecking = false;

  const requestShutdown = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      if (state.activeTurns.size > 0) {
        ui.log(
          'warn',
          `Stopping… waiting for ${state.activeTurns.size} active turn(s) to finish (press Ctrl+C again to cancel them immediately).`
        );
        ui.flash(
          'Stopping gracefully — press Ctrl+C again to force cancel active turns.'
        );
      } else {
        ui.log('info', 'Stopping connector…');
      }
      stop.abort();
      return;
    }
    ui.log('warn', 'Force-cancelling active turns…');
    forceCancelTurns.abort();
  };

  const handleCommand = (cmd: InteractiveCommand): void => {
    if (cmd === 'quit') {
      requestShutdown();
      return;
    }
    if (cmd === 'help') {
      ui.setView('help');
      return;
    }
    if (cmd === 'stats') {
      ui.setView('stats');
      return;
    }
    if (cmd === 'agents') {
      ui.setView('agents');
      return;
    }
    if (cmd === 'main') {
      ui.setView('main');
      return;
    }
    if (cmd === 'clear') {
      state.clearLogs();
      ui.flash('Activity log cleared.');
      return;
    }
    if (
      cmd === 'verbose' ||
      (cmd === 'toggle_verbose' && state.logLevel === 'basic')
    ) {
      state.setLogLevel('verbose');
      ui.log('info', 'Switched to VERBOSE logging.');
      ui.flash('Logging set to VERBOSE.');
      return;
    }
    if (
      cmd === 'basic' ||
      (cmd === 'toggle_verbose' && state.logLevel === 'verbose')
    ) {
      state.setLogLevel('basic');
      ui.log('info', 'Switched to BASIC logging.');
      ui.flash('Logging set to BASIC.');
      return;
    }
    if (
      cmd === 'pause' ||
      (cmd === 'toggle_pause' && !connectionControl?.isPaused())
    ) {
      connectionControl?.setPaused(true);
      ui.log(
        'warn',
        'Paused — not claiming new turns (running turns continue).'
      );
      ui.flash('Paused. Type `resume` to accept work again.');
      return;
    }
    if (
      cmd === 'resume' ||
      (cmd === 'toggle_pause' && connectionControl?.isPaused())
    ) {
      connectionControl?.setPaused(false);
      ui.log('info', 'Resumed — listening for work.');
      ui.flash('Resumed.');
      return;
    }
    if (cmd === 'check') {
      if (rechecking) {
        ui.flash('Agent check is already in progress…');
        return;
      }
      rechecking = true;
      ui.log('info', 'Re-checking local coding tools…');
      ui.flash('Checking local coding tools…');
      connectionControl?.requestRecheck();
    }
  };

  const ui = new ConnectorUI(
    state,
    { onCommand: handleCommand, onSigInt: requestShutdown },
    { plain: parsed.plain, json: parsed.json, logFile: parsed.logFile }
  );

  const onSigInt = (): void => requestShutdown();
  const onSigTerm = (): void => {
    stop.abort();
  };
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  ui.start();
  ui.log(
    'info',
    `CoRoid Connector v${VERSION} starting on ${name} (${process.platform}/${process.arch}) · API ${api} · max ${parsed.concurrency} parallel turns · auth in ${store.where()}`
  );

  try {
    const session = new Session(store);
    const describe = async (): Promise<ConnectorDescription> => {
      ui.log('info', 'Scanning coding agents on this machine…');
      const started = Date.now();
      const { snapshots, reports } = await probeAllAgents(homedir(), state);
      rechecking = false;
      const ready = reports.filter(r => r.state === 'ready' && r.tried).length;
      ui.log(
        'info',
        `Agent scan complete in ${formatDuration(Date.now() - started)}: ${ready}/${reports.length} ready.`
      );
      for (const snap of snapshots) {
        if (!snap.report) continue;
        ui.log(
          snap.report.state === 'ready' && snap.report.tried ? 'info' : 'debug',
          `  ${snap.name}${snap.report.version ? ` v${snap.report.version}` : ''}: ${foundOf(snap.report)}${snap.report.detail ? ` (${snap.report.detail})` : ''}`,
          !(snap.report.state === 'ready' && snap.report.tried)
        );
      }
      return {
        name,
        platform: process.platform,
        connectorVersion: VERSION,
        agents: reports,
      };
    };

    const ended = await stayConnected({
      api,
      session,
      describe,
      maxConcurrency: parsed.concurrency,
      onControl: control => {
        connectionControl = control;
      },
      onStateChange: (next, detail) => {
        state.setConnectionState(next, detail);
        if (next === 'connected') ui.log('info', `Connected to ${api}.`);
        else if (next === 'reconnecting')
          ui.log(
            'warn',
            `Connection lost (${detail ?? 'network error'}) — retrying…`
          );
        else if (next === 'not_served')
          ui.log(
            'error',
            `CoRoid is not serving this machine: ${detail ?? 'unavailable'}`
          );
      },
      onPoll: metrics => {
        state.recordPoll(metrics.latencyMs);
        ui.log(
          'debug',
          `Poll ok (${metrics.latencyMs}ms) · ${metrics.hasTurn ? 'turn received' : `idle, next in ${metrics.pollAfterSeconds}s`}`,
          true
        );
      },
      work: async turn => {
        const report = (
          events: ConnectorTurnEvent[]
        ): Promise<ConnectorTurnDirective> =>
          reportTurn(api, session, turn.id, events);
        const profile = agentProfiles(homedir()).find(
          known => known.id === turn.agent
        );
        if (!profile) {
          ui.log(
            'error',
            `Received turn ${turn.id} for unknown agent "${turn.agent}".`
          );
          await report([
            {
              type: 'failed',
              reason: 'This connector has no profile for that agent',
            },
          ]);
          return;
        }
        const active = state.startTurn({
          id: turn.id,
          agent: turn.agent,
          agentName: profile.name,
          model: turn.model,
          timeLimitSeconds: turn.timeLimitSeconds,
          context: turn.context,
        });
        const summaryParts = [
          `[#${active.slot}] ${profile.name}${turn.model ? ` (${turn.model})` : ''}`,
          turn.context?.role ? `role=${turn.context.role}` : null,
          turn.context?.projectName
            ? `project="${turn.context.projectName}"`
            : null,
          turn.context?.taskTitle ? `task="${turn.context.taskTitle}"` : null,
          turn.context?.requestedBy
            ? `requested by ${turn.context.requestedBy}`
            : null,
        ].filter(Boolean);
        ui.log('work', `Started ${summaryParts.join(' · ')}`);

        const outcome = await runTurn({
          turn,
          profile,
          report,
          signal: forceCancelTurns.signal,
          observer: {
            onActivity: activity => state.setTurnActivity(turn.id, activity),
            onToolCall: (tool, allowed) => {
              state.recordTurnToolCall(turn.id, tool, allowed);
              ui.log(
                allowed ? 'tool' : 'perm',
                `[#${active.slot}] ${profile.name} ${allowed ? 'called' : 'blocked'} tool: ${tool}`,
                allowed
              );
            },
            onPermission: (tool, allowed) => {
              ui.log(
                'perm',
                `[#${active.slot}] Permission ${allowed ? 'ALLOWED (once)' : 'DENIED (once)'}: ${tool}`,
                allowed
              );
            },
            onUsage: usage => {
              state.updateTurnUsage(turn.id, usage);
              ui.log(
                'debug',
                `[#${active.slot}] Tokens: ↑${formatTokens(usage.inputTokens)} ↓${formatTokens(usage.outputTokens)}`,
                true
              );
            },
            onMessage: text => {
              const first = text.split('\n')[0]?.trim().slice(0, 140) ?? '';
              if (first)
                ui.log(
                  'debug',
                  `[#${active.slot}] ${profile.name}: ${first}`,
                  true
                );
            },
            onStderr: line => {
              ui.log(
                'debug',
                `[#${active.slot}] ${profile.name} stderr: ${line.slice(0, 180)}`,
                true
              );
            },
          },
        });
        const done = state.finishTurn(turn.id, outcome);
        const duration = done ? formatDuration(done.durationMs) : '0s';
        const tokText =
          done && (done.inputTokens > 0 || done.outputTokens > 0)
            ? ` · tokens ↑${formatTokens(done.inputTokens)} ↓${formatTokens(done.outputTokens)}`
            : '';
        const toolText = done ? ` · ${done.toolCalls} tool call(s)` : '';
        ui.log(
          outcome === 'ended' ? 'work' : 'warn',
          outcome === 'ended'
            ? `[#${active.slot}] ${profile.name} finished in ${duration}${toolText}${tokText}.`
            : `[#${active.slot}] ${profile.name} did not finish (${duration}); CoRoid continues on its cloud model.`
        );
      },
      sleep,
      say: line => {
        if (line === 'Connected.') return;
        ui.log('info', line);
      },
      signal: stop.signal,
    });

    if (ended === 'signed_out') {
      ui.stop(
        'This machine was disconnected in CoRoid. Start the connector again to sign in.'
      );
      return 1;
    }
    ui.stop(
      'This machine will show as disconnected in CoRoid within a minute.'
    );
    return 0;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    lock.release();
  }
}

async function logout(api: string, file: string): Promise<number> {
  const store = new SignInStore(
    file,
    api,
    () => undefined,
    platformSecretStore()
  );
  const signedIn = store.read();
  if (!signedIn) {
    say('This machine is not signed in.');
    return 0;
  }
  store.clear();
  const revoked = await fetch(`${api}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: signedIn.refreshToken }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).then(
    response => response.ok,
    () => false
  );
  say(
    revoked
      ? 'Signed out. To remove this machine from your machines, disconnect it in CoRoid.'
      : 'The sign-in was removed from this machine, but CoRoid could not be told. Disconnect the machine in CoRoid to end it there.'
  );
  return revoked ? 0 : 1;
}

export async function main(args: string[]): Promise<number> {
  const parsed = parseCliArgs(args);
  if (!parsed.ok) {
    say(parsed.message);
    return 2;
  }
  if (parsed.command === 'help') {
    say(USAGE);
    return 0;
  }
  if (parsed.command === 'version') {
    say(VERSION);
    return 0;
  }
  const api = apiAddress(parsed.api);
  if (!api) {
    say('--api must be CoRoid’s address, for example https://api.coroid.ai');
    return 2;
  }
  const name =
    (parsed.name ?? hostname().replace(/\.local$/, '')).trim().slice(0, 100) ||
    'This machine';
  if (parsed.command === 'add') {
    if (!isAddableAgent(parsed.agentArg)) {
      say(
        'Name the agent to add: coroid-connector add codex, or coroid-connector add claude.'
      );
      return 2;
    }
    return (await addAgent(parsed.agentArg, { home: homedir(), say })) ? 0 : 1;
  }
  const file = parsed.stateDir
    ? storeFileIn(parsed.stateDir, api)
    : storeFileFor(homedir(), api);
  if (
    parsed.command === 'doctor' ||
    parsed.command === 'status' ||
    parsed.command === 'check'
  ) {
    const report = await runDoctor({ api, file });
    if (parsed.json) {
      say(JSON.stringify(report, null, 2));
      return 0;
    }
    if (parsed.command === 'doctor') {
      say(formatDoctorReport(report));
      return report.apiReachable ? 0 : 1;
    }
    say(`CoRoid Connector v${VERSION} (${report.timestamp})`);
    say('Detected coding agents:');
    for (const agent of report.agents) {
      say(
        `  ${agent.name}${agent.report.version ? ` v${agent.report.version}` : ''}: ${foundOf(agent.report)}${agent.report.detail ? ` (${agent.report.detail})` : ''}`
      );
      if (parsed.verbose && agent.binary) say(`    path: ${agent.binary}`);
    }
    say(
      report.signedIn
        ? `Signed in at ${api}; tokens are kept in ${report.credentialStore}.`
        : `Not signed in at ${api}.`
    );
    return 0;
  }
  if (parsed.command === 'logout') return logout(api, file);
  return runConnector(api, name, file, parsed);
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  (error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
);
