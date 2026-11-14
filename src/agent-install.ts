import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import claudeLockfile from './adapters/claude/package-lock.json';
import claudeManifest from './adapters/claude/package.json';
import codexLockfile from './adapters/codex/package-lock.json';
import codexManifest from './adapters/codex/package.json';

/**
 * Plan 48a (D3): the ACP adapters the connector starts Codex and Claude Code
 * through. Each brings its own native agent (about 350 MB), so none is a
 * dependency of the connector: a person adds the agents they use, and each
 * is installed from the lockfile this release carries, which pins every
 * package with its integrity hash for every platform. Nothing is downloaded
 * when the connector runs.
 */
export type AddableAgent = 'codex' | 'claude';

interface Adapter {
  name: string;
  /** The adapter's npm package, whose `dist/index.js` speaks ACP. */
  package: string;
  manifest: { dependencies: Record<string, string> };
  /** The release's lockfile, written as it is; its entries are npm's to read. */
  lockfile: { lockfileVersion?: number; packages: Record<string, object> };
}

const adapter = (name: string, manifest: Adapter['manifest'], lockfile: Adapter['lockfile']): Adapter => ({
  name,
  package: Object.keys(manifest.dependencies)[0] ?? '',
  manifest,
  lockfile,
});

export const ADAPTERS: Record<AddableAgent, Adapter> = {
  codex: adapter('Codex', codexManifest, codexLockfile),
  claude: adapter('Claude', claudeManifest, claudeLockfile),
};

export const isAddableAgent = (value: string): value is AddableAgent => value === 'codex' || value === 'claude';

/** The version of an agent's adapter this release installs: the one its profile was tried on. */
export const adapterVersion = (agent: AddableAgent): string => Object.values(ADAPTERS[agent].manifest.dependencies)[0] ?? '0';

/** Where an agent's adapter of this release is installed, under the connector's own directory. */
export const adapterDirectory = (home: string, agent: AddableAgent): string =>
  join(home, '.coroid', 'connector', 'agents', `${agent}@${adapterVersion(agent)}`);

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * The adapter's entry point when the agent was added from this release's
 * lockfile and its install finished; null otherwise.
 */
export function installedAdapter(home: string, agent: AddableAgent): string | null {
  const directory = adapterDirectory(home, agent);
  const entry = join(directory, 'node_modules', ADAPTERS[agent].package, 'dist', 'index.js');
  const read = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(directory, file), 'utf8'));
    } catch {
      return null;
    }
  };
  const installed = existsSync(join(directory, 'installed')) && existsSync(entry);
  return installed && same(read('package-lock.json'), ADAPTERS[agent].lockfile) ? entry : null;
}

/**
 * Installs an agent's adapter: this release's manifest and lockfile, written
 * to the agent's directory and installed with `npm ci --ignore-scripts`
 * (exactly what the lockfile names, checked against its hashes, no install
 * scripts). Marked as added only when that succeeded.
 */
export async function addAgent(
  agent: AddableAgent,
  options: { home: string; npm?: string[]; say(line: string): void }
): Promise<boolean> {
  const { name } = ADAPTERS[agent];
  const agents = join(options.home, '.coroid', 'connector', 'agents');
  mkdirSync(agents, { recursive: true, mode: 0o700 });
  chmodSync(join(options.home, '.coroid', 'connector'), 0o700);
  chmodSync(agents, 0o700);
  const directory = adapterDirectory(options.home, agent);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(ADAPTERS[agent].manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'package-lock.json'), `${JSON.stringify(ADAPTERS[agent].lockfile, null, 2)}\n`);

  options.say(`Adding ${name} (${ADAPTERS[agent].package} ${adapterVersion(agent)}) from the packages this connector release locks…`);
  const [command, ...prefix] = options.npm ?? ['npm'];
  const code = await new Promise<number | null>(resolve => {
    // The settings that decide what a lockfile installs are stated: a person's npm configuration must not change them.
    const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps=false', '--strict-peer-deps=false'];
    const child = spawn(command, [...prefix, ...args], {
      cwd: directory,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve(null));
    child.on('exit', resolve);
  });
  if (code !== 0) {
    options.say(`${name} could not be added: npm ${code === null ? 'did not start' : `ended with ${code}`}.`);
    return false;
  }
  writeFileSync(join(directory, 'installed'), `${new Date().toISOString()}\n`);
  if (!installedAdapter(options.home, agent)) {
    options.say(`${name} could not be added: the installed adapter was not where it belongs.`);
    return false;
  }
  options.say(`${name} is added. Sign in to it as you would to use it yourself, then start the connector.`);
  return true;
}
