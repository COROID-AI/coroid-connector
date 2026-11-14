import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, addAgent, adapterDirectory, installedAdapter } from './agent-install.js';
import { agentProfiles } from './agent-profiles.js';
import { probeAgent } from './probe.js';

/**
 * Plan 48a (D3): the Codex and Claude adapters bring their own native agents
 * (about 350 MB each), so they are installed only when a person adds the
 * agent, from a lockfile the release carries, into the connector's own
 * directory. Nothing is downloaded when the connector runs.
 *
 * Failure modes, written before the code:
 * I1 `add` installs something other than the release's lockfile: another
 *    command than `npm ci`, install scripts allowed, or outside the
 *    connector's own directory;
 * I2 a lockfile lets a package in without its integrity hash, from another
 *    registry, or by a version range;
 * I3 an agent that is not added is started anyway (downloaded at run time),
 *    or reported as working, or without the command that adds it;
 * I4 an adapter added from an older lockfile is used as if it were this
 *    release's;
 * I5 a profile's command downloads anything (`npx`);
 * I6 the connector's directory is readable by other users of the machine;
 * I7 an install that failed leaves an adapter that counts as added;
 * I8 the person's own npm settings (legacy or strict peer dependencies)
 *    change what is installed, so the release's lockfile is refused or
 *    installed differently than tested.
 */
// The real path: on macOS the temporary directory is a link, and a process reports where it really runs.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'coroid-connector-install-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let run = 0;
const home = () => {
  run += 1;
  const dir = join(scratch, `home-${run}`);
  mkdirSync(dir);
  return dir;
};

/** A stand-in for npm: records how it was called, and installs the adapter's entry point unless told to fail. */
function fakeNpm(dir: string, options: { fail?: boolean } = {}): { command: string[]; calls: () => Array<{ args: string[]; cwd: string }> } {
  const log = join(dir, 'npm-calls.jsonl');
  const script = join(dir, 'fake-npm.mjs');
  writeFileSync(
    script,
    `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (${options.fail ? 'true' : 'false'}) process.exit(1);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const name of Object.keys(manifest.dependencies)) {
  const own = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages['node_modules/' + name];
  const bin = join('node_modules', name, 'dist', 'index.js');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '// ' + own.version + '\\n');
  writeFileSync(join('node_modules', name, 'package.json'), JSON.stringify({ name, version: own.version, bin: { x: 'dist/index.js' } }));
}
`
  );
  return {
    command: [process.execPath, script],
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []),
  };
}

describe('the release’s adapter lockfiles', () => {
  it.each(['codex', 'claude'] as const)('I2: the %s lockfile pins every package by exact version and hash, from npm', agent => {
    const { manifest, lockfile } = ADAPTERS[agent];
    const packages = Object.entries(lockfile.packages as Record<string, { version?: string; resolved?: string; integrity?: string }>).filter(
      ([path]) => path !== ''
    );
    expect(packages.length).toBeGreaterThan(3);
    for (const [path, entry] of packages) {
      expect([path, typeof entry.integrity === 'string' && entry.integrity.startsWith('sha512-')]).toEqual([path, true]);
      expect([path, entry.resolved?.startsWith('https://registry.npmjs.org/')]).toEqual([path, true]);
    }
    // The adapter itself by an exact version, and the lockfile made for exactly this manifest.
    for (const version of Object.values(manifest.dependencies as Record<string, string>)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockfile.packages['']).toMatchObject({ dependencies: manifest.dependencies });
  });
});

describe('adding an agent', () => {
  it('I1, I6: installs the release’s lockfile with npm ci and no install scripts, in the connector’s own directory', async () => {
    const dir = home();
    const npm = fakeNpm(dir);
    const said: string[] = [];
    expect(await addAgent('codex', { home: dir, npm: npm.command, say: line => said.push(line) })).toBe(true);

    const target = adapterDirectory(dir, 'codex');
    expect(target.startsWith(join(dir, '.coroid', 'connector', 'agents'))).toBe(true);
    // I8: the settings that decide what a lockfile installs are stated, not left to the person's npm configuration.
    expect(npm.calls()).toEqual([
      {
        args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps=false', '--strict-peer-deps=false'],
        cwd: target,
      },
    ]);
    expect(JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8'))).toEqual(ADAPTERS.codex.lockfile);
    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))).toEqual(ADAPTERS.codex.manifest);
    expect(statSync(join(dir, '.coroid', 'connector', 'agents')).mode & 0o777).toBe(0o700);
    expect(installedAdapter(dir, 'codex')).toBe(join(target, 'node_modules', ADAPTERS.codex.package, 'dist', 'index.js'));
    expect(said.join('\n')).toMatch(/Codex is added/);
  });

  it('I7: an install that failed leaves nothing that counts as added', async () => {
    const dir = home();
    const said: string[] = [];
    expect(await addAgent('claude', { home: dir, npm: fakeNpm(dir, { fail: true }).command, say: line => said.push(line) })).toBe(false);
    expect(installedAdapter(dir, 'claude')).toBeNull();
    expect(said.join('\n')).toMatch(/could not be added/);
  });

  it('I4: an adapter added from another lockfile does not count as this release’s', async () => {
    const dir = home();
    await addAgent('codex', { home: dir, npm: fakeNpm(dir).command, say: () => undefined });
    const target = adapterDirectory(dir, 'codex');
    writeFileSync(join(target, 'package-lock.json'), JSON.stringify({ ...ADAPTERS.codex.lockfile, lockfileVersion: 2 }));
    expect(installedAdapter(dir, 'codex')).toBeNull();
  });
});

describe('an agent the connector starts', () => {
  it('I3, I5: one that is not added is not started, and says how to add it', async () => {
    const dir = home();
    const codex = agentProfiles(dir).find(profile => profile.id === 'codex');
    if (!codex) throw new Error('No Codex profile');
    expect(codex.command).toBeNull();
    const report = await probeAgent(codex);
    expect(report).toMatchObject({ id: 'codex', version: null, tried: false, state: 'not_working', models: null });
    expect(report.detail).toBe('Not added: run coroid-connector add codex');
  });

  it('I3, I5: one that is added starts from the connector’s directory with this Node, and none downloads', async () => {
    const dir = home();
    await addAgent('claude', { home: dir, npm: fakeNpm(dir).command, say: () => undefined });
    const profiles = agentProfiles(dir);
    const claude = profiles.find(profile => profile.id === 'claude');
    expect(claude?.command).toEqual([process.execPath, installedAdapter(dir, 'claude')]);
    for (const profile of profiles) expect([profile.id, profile.command?.[0]]).not.toEqual([profile.id, 'npx']);
    // OpenCode is the person's own installation.
    expect(profiles.find(profile => profile.id === 'opencode')?.command).toEqual(['opencode', 'acp']);
  });
});
