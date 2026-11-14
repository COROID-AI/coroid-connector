import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macKeychain, platformSecretStore, secretService, type Run, type SecretStore } from './secret-store.js';
import { SignInStore, type SignIn } from './store.js';

/**
 * Plan 48b (D5): a connector's tokens are kept in the operating system's
 * credential store: the macOS keychain, or the Secret Service on Linux. A
 * file (0600) only where there is none.
 *
 * Failure modes, written before the code:
 * C1 a token is written to the file although a credential store exists;
 * C2 a token appears on a command line, where other users of the machine can
 *    read it from the process list;
 * C3 a sign-in kept in the store cannot be read back, or another CoRoid
 *    address's is read;
 * C4 a sign-in an older connector kept in the file is lost, or stays in the
 *    file after the next renewal;
 * C5 `logout` leaves the tokens in the store;
 * C6 a store that fails loses the sign-in instead of keeping it in the file,
 *    or does so without a word;
 * C7 on Linux, a Secret Service tool that cannot reach a keyring (a server
 *    without a desktop session) is taken for a store, and every write fails;
 * C8 a sign-in store made without naming a credential store reaches the
 *    machine's own (a test would write to the developer's keychain).
 *
 * Found after 0.5.2 was released, written before the fix (0.5.3):
 * C9 two sign-ins at one CoRoid address, in two state directories (one per
 *    organization), share one entry: the second overwrites the first's
 *    tokens, and logging out of one takes the other's;
 * C10 a sign-in 0.5.2 kept under the address alone is not read after the
 *    upgrade, so the person must sign in again; or it stays under that entry
 *    after the next renewal, where another sign-in could take it.
 */
const scratch = mkdtempSync(join(tmpdir(), 'coroid-connector-secrets-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fileFor = () => join(scratch, `sign-in-${++n}.json`);
const API = 'https://api.coroid.ai';
const signIn = (extra: Partial<SignIn> = {}): SignIn => ({
  api: API,
  clientId: 'client-1',
  accessToken: 'cmp_at_SECRETaccess0123456789',
  refreshToken: 'cmp_rt_SECRETrefresh0123456789',
  accessTokenExpiresAt: 1_900_000_000_000,
  ...extra,
});

/** A credential store in memory that records every command it is asked to run. */
function fakeStore(options: { failWrites?: boolean } = {}): { store: SecretStore; items: Map<string, string>; argv: string[][] } {
  const items = new Map<string, string>();
  const argv: string[][] = [];
  const store: SecretStore = {
    name: 'a test store',
    read: account => items.get(account) ?? null,
    write: (account, secret) => {
      if (options.failWrites) throw new Error('the keyring is locked');
      items.set(account, secret);
    },
    remove: account => {
      items.delete(account);
    },
  };
  return { store, items, argv };
}

describe('a sign-in with a credential store', () => {
  it('C1, C3: keeps the tokens in the store, the rest in the file, and reads it back', () => {
    const { store, items } = fakeStore();
    const file = fileFor();
    const kept = new SignInStore(file, API, () => undefined, store);
    kept.write(signIn());
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('SECRET');
    expect(JSON.parse(onDisk)).toEqual({ api: API, clientId: 'client-1', accessTokenExpiresAt: 1_900_000_000_000, tokensIn: 'a test store' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect([...items.keys()]).toEqual([`${API} ${file}`]);
    expect(new SignInStore(file, API, () => undefined, store).read()).toEqual(signIn());
    // Another address's file is not this sign-in.
    const said: string[] = [];
    expect(new SignInStore(file, 'https://staging-api.coroid.ai', reason => said.push(reason), store).read()).toBeNull();
  });

  it('C4: a sign-in an older connector kept in the file is read, and moves to the store at the next write', () => {
    const { store, items } = fakeStore();
    const file = fileFor();
    writeFileSync(file, JSON.stringify(signIn()), { mode: 0o600 });
    const kept = new SignInStore(file, API, () => undefined, store);
    const old = kept.read();
    expect(old).toEqual(signIn());
    kept.write({ ...signIn(), accessToken: 'cmp_at_SECRETrenewed' });
    expect(readFileSync(file, 'utf8')).not.toContain('SECRET');
    expect(items.size).toBe(1);
    expect(kept.read()?.accessToken).toBe('cmp_at_SECRETrenewed');
  });

  it('C5: logout takes the tokens out of the store too', () => {
    const { store, items } = fakeStore();
    const file = fileFor();
    const kept = new SignInStore(file, API, () => undefined, store);
    kept.write(signIn());
    kept.clear();
    expect(items.size).toBe(0);
    expect(kept.read()).toBeNull();
  });

  it('C3: tokens missing from the store make no sign-in, and say why', () => {
    const { store, items } = fakeStore();
    const file = fileFor();
    new SignInStore(file, API, () => undefined, store).write(signIn());
    items.clear();
    const said: string[] = [];
    expect(new SignInStore(file, API, reason => said.push(reason), store).read()).toBeNull();
    expect(said).toEqual(['Its tokens are not in a test store']);
  });

  it('C6: a store that fails keeps the sign-in in the file, and says so', () => {
    const { store } = fakeStore({ failWrites: true });
    const file = fileFor();
    const said: string[] = [];
    const kept = new SignInStore(file, API, () => undefined, store, line => said.push(line));
    kept.write(signIn());
    expect(kept.read()).toEqual(signIn());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(said.join('\n')).toMatch(/could not be kept in a test store \(the keyring is locked\).*file only you can read/);
  });

  it('C9: two sign-ins at one address, in two directories, keep their own tokens and leave one another', () => {
    const { store, items } = fakeStore();
    const first = new SignInStore(fileFor(), API, () => undefined, store);
    const second = new SignInStore(fileFor(), API, () => undefined, store);
    first.write(signIn({ clientId: 'client-coroid', accessToken: 'cmp_at_SECRETfirst' }));
    second.write(signIn({ clientId: 'client-expo', accessToken: 'cmp_at_SECRETsecond' }));
    expect(items.size).toBe(2);
    expect(first.read()).toMatchObject({ clientId: 'client-coroid', accessToken: 'cmp_at_SECRETfirst' });
    expect(second.read()).toMatchObject({ clientId: 'client-expo', accessToken: 'cmp_at_SECRETsecond' });
    second.clear();
    expect(second.read()).toBeNull();
    expect(first.read()).toMatchObject({ accessToken: 'cmp_at_SECRETfirst' });
  });

  it('C10: a sign-in 0.5.2 kept under the address alone is read, and moves to its own entry at the next write', () => {
    const { store, items } = fakeStore();
    const file = fileFor();
    // As 0.5.2 left it: the file names the store, the tokens are under the address.
    writeFileSync(file, JSON.stringify({ api: API, clientId: 'client-1', accessTokenExpiresAt: 1_900_000_000_000, tokensIn: 'a test store' }), { mode: 0o600 });
    store.write(API, Buffer.from(JSON.stringify({ accessToken: 'cmp_at_SECRETold', refreshToken: 'cmp_rt_SECRETold' })).toString('base64url'));
    const kept = new SignInStore(file, API, () => undefined, store);
    expect(kept.read()).toMatchObject({ clientId: 'client-1', accessToken: 'cmp_at_SECRETold', refreshToken: 'cmp_rt_SECRETold' });
    kept.write(signIn({ accessToken: 'cmp_at_SECRETrenewed' }));
    expect([...items.keys()]).toEqual([`${API} ${file}`]);
    expect(kept.read()?.accessToken).toBe('cmp_at_SECRETrenewed');
  });

  it('C8: the credential store is the caller’s choice, never a default', () => {
    // @ts-expect-error -- a SignInStore without its credential store must not compile: a default would reach the machine's keychain from a test.
    const unnamed = new SignInStore(fileFor(), API, () => undefined);
    expect(unnamed.where()).toBe('a file only you can read');
  });

  it('C1: without a store the file keeps the sign-in, readable only by its owner', () => {
    const file = fileFor();
    const kept = new SignInStore(file, API, () => undefined, null);
    kept.write(signIn());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(kept.read()).toEqual(signIn());
    expect(kept.where()).toBe('a file only you can read');
  });
});

/** A command runner that records what it was given, and answers as told. */
function recorder(answer: (command: string, args: string[], input?: string) => { status: number; stdout?: string } = () => ({ status: 0 })) {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const run: Run = (command, args, input) => {
    calls.push({ command, args, input });
    const given = answer(command, args, input);
    return { status: given.status, stdout: given.stdout ?? '' };
  };
  return { run, calls };
}

describe('the operating systems’ credential stores', () => {
  const SECRET = 'eyJhY2Nlc3NUb2tlbiI6ImNtcF9hdF9TRUNSRVQifQ';

  it('C2: the macOS keychain gets the secret on standard input, never in the arguments', () => {
    const { run, calls } = recorder((_command, args) => (args.includes('-w') && args[0] === 'find-generic-password' ? { status: 0, stdout: `${SECRET}\n` } : { status: 0 }));
    const keychain = macKeychain(run);
    keychain.write(API, SECRET);
    expect(keychain.read(API)).toBe(SECRET);
    keychain.remove(API);
    for (const call of calls) expect(call.args.join(' ')).not.toContain(SECRET);
    expect(calls[0]).toEqual({
      command: 'security',
      args: ['-i'],
      input: `add-generic-password -U -a "${API}" -s "coroid-connector" -w "${SECRET}"\n`,
    });
    expect(calls[1].args).toEqual(['find-generic-password', '-a', API, '-s', 'coroid-connector', '-w']);
    expect(calls[2].args).toEqual(['delete-generic-password', '-a', API, '-s', 'coroid-connector']);
  });

  it('C2: the Secret Service gets the secret on standard input, never in the arguments', () => {
    const { run, calls } = recorder(() => ({ status: 0, stdout: SECRET }));
    const keyring = secretService(run);
    keyring.write(API, SECRET);
    expect(keyring.read(API)).toBe(SECRET);
    for (const call of calls) expect(call.args.join(' ')).not.toContain(SECRET);
    expect(calls[0]).toEqual({
      command: 'secret-tool',
      args: ['store', '--label=CoRoid connector', 'service', 'coroid-connector', 'account', API],
      input: SECRET,
    });
  });

  it('C7: on Linux a Secret Service that cannot keep a secret is no store, and one that can is', () => {
    const locked = recorder(command => (command === 'secret-tool' ? { status: 1 } : { status: 0 }));
    expect(platformSecretStore('linux', locked.run)).toBeNull();
    const working = new Map<string, string>();
    const unlocked = recorder((_command, args, input) => {
      const account = args[args.length - 1];
      if (args[0] === 'store') working.set(account, input ?? '');
      if (args[0] === 'clear') working.delete(account);
      return args[0] === 'lookup' ? { status: working.has(account) ? 0 : 1, stdout: working.get(account) } : { status: 0 };
    });
    expect(platformSecretStore('linux', unlocked.run)?.name).toMatch(/Secret Service/);
    expect(working.size).toBe(0);
    expect(platformSecretStore('darwin', recorder().run)?.name).toBe('the macOS keychain');
    expect(platformSecretStore('win32', recorder().run)).toBeNull();
  });
});

const onMac = process.platform === 'darwin' && process.env.CONNECTOR_KEYCHAIN_TEST === '1' ? describe : describe.skip;
onMac('the real macOS keychain (CONNECTOR_KEYCHAIN_TEST=1)', () => {
  it('C2, C3, C5: keeps, reads and removes a secret', () => {
    const store = platformSecretStore('darwin');
    if (!store) throw new Error('No keychain');
    // As a sign-in's entry is named (0.5.3): its address, a space and its file's path, with a quote in it.
    const account = `https://connector-test-${Date.now()}.invalid /tmp/a "state" dir/connector-test.invalid.json`;
    store.write(account, 'dGVzdC1zZWNyZXQ');
    expect(store.read(account)).toBe('dGVzdC1zZWNyZXQ');
    store.remove(account);
    expect(store.read(account)).toBeNull();
  });
});
