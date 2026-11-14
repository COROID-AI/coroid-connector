import { spawn } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import type {
  ConnectorDescription,
  ConnectorTurnDirective,
  ConnectorTurnEvent,
  LocalAgentReport,
} from './protocol/local-agents.js';
import { addAgent, isAddableAgent } from './agent-install.js';
import { agentProfiles } from './agent-profiles.js';
import { reportTurn, stayConnected } from './connect.js';
import { holdLock } from './lock.js';
import { probeAgent } from './probe.js';
import { Session } from './session.js';
import { signIn } from './sign-in.js';
import { runTurn } from './turn.js';
import { platformSecretStore } from './secret-store.js';
import { SignInStore, storeFileFor, storeFileIn } from './store.js';
import { VERSION } from './version.js';

const USAGE = `coroid-connector ${VERSION}

Connects this machine to CoRoid, so that coding agents on it can do work
CoRoid assigns to them. The agents get CoRoid's tools and nothing of this
machine. CoRoid gets no access to files or programs here.

  coroid-connector [--api <address>] [--name <machine name>]
      Signs in (once, in your browser) and stays connected until you stop it.
      --no-browser         prints the approval address instead of opening it
      --state-dir <dir>    keeps the sign-in there instead of ~/.coroid/connector
  coroid-connector add codex|claude
      Adds Codex or Claude Code: installs the adapter this release locks (each
      brings its own agent, about 350 MB) into ~/.coroid/connector/agents.
      OpenCode needs no adding: CoRoid uses your own installation.
  coroid-connector status
      Shows the coding agents CoRoid can use on this machine.
  coroid-connector logout [--api <address>]
      Forgets this machine's sign-in.
`;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

/** CoRoid's address: https, or a developer's own machine over http. */
function apiAddress(given: string | undefined): string | null {
  const address = given ?? 'https://api.coroid.ai';
  if (!URL.canParse(address)) return null;
  const url = new URL(address);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
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
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** What the check found of one agent, in a few words. */
function foundOf(agent: LocalAgentReport): string {
  if (agent.state === 'sign_in_needed') return 'needs you to sign in to it';
  if (agent.state !== 'ready') return 'not found or not working';
  const on = agent.models?.current ? `, on ${agent.models.current}` : '';
  return `ready${on}${agent.tried ? '' : ', but CoRoid has not tried this version and will not use it'}`;
}

async function describeMachine(name: string): Promise<ConnectorDescription> {
  say('Looking for coding agents on this machine…');
  const profiles = agentProfiles(homedir());
  const agents = await Promise.all(profiles.map(profile => probeAgent(profile)));
  for (const agent of agents) {
    const profile = profiles.find(known => known.id === agent.id);
    say(`  ${profile?.name ?? agent.id}${agent.version ? ` ${agent.version}` : ''}: ${foundOf(agent)}${agent.detail ? ` (${agent.detail})` : ''}`);
  }
  return { name, platform: process.platform, connectorVersion: VERSION, agents };
}

const sleep = (seconds: number, signal: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, seconds * 1000);
    signal.addEventListener('abort', done);
  });

async function run(
  api: string,
  name: string,
  options: { file: string; browser: boolean }
): Promise<number> {
  const { file } = options;
  const store = new SignInStore(
    file,
    api,
    reason => say(`The saved sign-in could not be used (${reason}); signing in again.`),
    platformSecretStore(),
    say
  );
  const existing = store.read();
  if (!existing) {
    store.write(
      await signIn({ api, machineName: name, open: url => openInBrowser(url, options.browser) })
    );
  }
  const lock = holdLock(`${file}.lock`);
  if (!lock) {
    say('A connector is already running for this sign-in on this machine.');
    return 1;
  }

  const stop = new AbortController();
  const stopNow = (): void => stop.abort();
  process.once('SIGINT', stopNow);
  process.once('SIGTERM', stopNow);
  try {
    let description: ConnectorDescription | null = null;
    const session = new Session(store);
    const ended = await stayConnected({
      api,
      session,
      describe: async () => (description ??= await describeMachine(name)),
      work: async turn => {
        const report = (events: ConnectorTurnEvent[]): Promise<ConnectorTurnDirective> =>
          reportTurn(api, session, turn.id, events);
        const profile = agentProfiles(homedir()).find(known => known.id === turn.agent);
        if (!profile) {
          await report([{ type: 'failed', reason: 'This connector has no profile for that agent' }]);
          return;
        }
        say(`${profile.name} is doing work for CoRoid…`);
        const outcome = await runTurn({ turn, profile, report });
        say(outcome === 'ended' ? `${profile.name} is done.` : `${profile.name} could not do it; CoRoid goes on without this machine.`);
      },
      sleep,
      say,
      signal: stop.signal,
    });
    if (ended === 'signed_out') {
      say('This machine was disconnected in CoRoid. Start the connector again to sign in.');
      return 1;
    }
    say('Stopped. This machine shows as not connected within a minute.');
    return 0;
  } finally {
    lock.release();
  }
}

async function logout(api: string, file: string): Promise<number> {
  const store = new SignInStore(file, api, () => undefined, platformSecretStore());
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
  if (args.includes('--help') || args.includes('-h')) {
    say(USAGE);
    return 0;
  }
  if (args.includes('--version')) {
    say(VERSION);
    return 0;
  }
  const api = apiAddress(option(args, 'api'));
  if (!api) {
    say('--api must be CoRoid’s address, for example https://api.coroid.ai');
    return 2;
  }
  const name = (option(args, 'name') ?? hostname().replace(/\.local$/, '')).trim().slice(0, 100) || 'This machine';
  const command = args[0]?.startsWith('--') ? 'run' : (args[0] ?? 'run');
  if (command === 'add') {
    const agent = args[1] ?? '';
    if (!isAddableAgent(agent)) {
      say('Name the agent to add: coroid-connector add codex, or coroid-connector add claude.');
      return 2;
    }
    return (await addAgent(agent, { home: homedir(), say })) ? 0 : 1;
  }
  const stateDir = option(args, 'state-dir');
  const file = stateDir ? storeFileIn(stateDir, api) : storeFileFor(homedir(), api);
  if (command === 'status') {
    await describeMachine(name);
    const store = new SignInStore(file, api, () => undefined, platformSecretStore());
    say(store.read() ? `Signed in at ${api}; the tokens are kept in ${store.where()}.` : `Not signed in at ${api}.`);
    return 0;
  }
  if (command === 'logout') return logout(api, file);
  if (command === 'run') return run(api, name, { file, browser: !args.includes('--no-browser') });
  say(USAGE);
  return 2;
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
