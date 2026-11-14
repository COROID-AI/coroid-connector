import { spawnSync } from 'node:child_process';

/**
 * Plan 48b (D5): the operating system's credential store, where a
 * connector's tokens are kept. A secret is always handed to the store's tool
 * on its standard input: a command line is visible to every user of the
 * machine in the process list.
 */
export interface SecretStore {
  /** Where the secrets are, in words, for `status` and for what the connector says. */
  name: string;
  read(account: string): string | null;
  /** Throws when the store did not keep it. */
  write(account: string, secret: string): void;
  remove(account: string): void;
}

/** Runs a tool with arguments and, optionally, standard input. */
export type Run = (command: string, args: string[], input?: string) => { status: number | null; stdout: string };

const SERVICE = 'coroid-connector';

export const runTool: Run = (command, args, input) => {
  const done = spawnSync(command, args, { input: input ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  return { status: done.error ? null : done.status, stdout: done.stdout ?? '' };
};

/** A value for `security -i`'s own command line, which it reads from standard input. */
const quoted = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** The macOS keychain, through `security`. */
export function macKeychain(run: Run = runTool): SecretStore {
  return {
    name: 'the macOS keychain',
    read: account => {
      const found = run('security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
      return found.status === 0 ? found.stdout.replace(/\n$/, '') : null;
    },
    write: (account, secret) => {
      // `security -i` reads its commands from standard input, so the secret is on no command line.
      const done = run('security', ['-i'], `add-generic-password -U -a ${quoted(account)} -s ${quoted(SERVICE)} -w ${quoted(secret)}\n`);
      if (done.status !== 0) throw new Error(`security ended with ${done.status ?? 'no status'}`);
    },
    remove: account => {
      run('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
    },
  };
}

/** The Secret Service of a Linux desktop session (GNOME Keyring, KWallet), through `secret-tool`. */
export function secretService(run: Run = runTool): SecretStore {
  return {
    name: 'the Secret Service (your desktop keyring)',
    read: account => {
      const found = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
      return found.status === 0 && found.stdout ? found.stdout : null;
    },
    write: (account, secret) => {
      const done = run('secret-tool', ['store', '--label=CoRoid connector', 'service', SERVICE, 'account', account], secret);
      if (done.status !== 0) throw new Error(`secret-tool ended with ${done.status ?? 'no status'}`);
    },
    remove: account => {
      run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    },
  };
}

/**
 * The credential store of this machine, or null where there is none to use:
 * Windows (not yet tried), and a Linux without a working keyring (a server
 * without a desktop session), which is found out by keeping and removing a
 * probe secret.
 */
export function platformSecretStore(platform: NodeJS.Platform = process.platform, run: Run = runTool): SecretStore | null {
  if (platform === 'darwin') return macKeychain(run);
  if (platform !== 'linux') return null;
  const keyring = secretService(run);
  const probe = `probe-${process.pid}-${Date.now()}`;
  const stored = run('secret-tool', ['store', '--label=CoRoid connector', 'service', SERVICE, 'account', probe], 'probe').status === 0;
  const kept = stored && keyring.read(probe) === 'probe';
  if (stored) keyring.remove(probe);
  // No keyring to reach: the sign-in is kept in a file only its owner can read.
  return kept ? keyring : null;
}
