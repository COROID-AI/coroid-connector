import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { SecretStore } from './secret-store.js';

/** A connector's sign-in at one CoRoid address. The tokens are secrets: they are never printed. */
export interface SignIn {
  api: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  accessTokenExpiresAt: number;
}

/** The file for one CoRoid address in a directory of sign-ins. */
export const storeFileIn = (directory: string, api: string): string =>
  join(directory, `${new URL(api).host.replace(/[^a-z0-9.-]/gi, '_')}.json`);

/** Where the sign-in for one CoRoid address is kept under a person's home directory. */
export const storeFileFor = (home: string, api: string): string =>
  storeFileIn(join(home, '.coroid', 'connector'), api);

/** The part of a sign-in that is not secret: what the file keeps when the tokens are in a credential store. */
interface KeptElsewhere {
  api: string;
  clientId: string;
  accessTokenExpiresAt: number;
  /** The store's name, as `SecretStore.name` gives it. */
  tokensIn: string;
}

const FILE_ONLY = 'a file only you can read';

/**
 * The credential store's entry for one sign-in: its CoRoid address and its
 * file. A machine signs in to one organization per state directory, so two
 * sign-ins at one address need two entries (0.5.2 named the entry by the
 * address alone, and the second overwrote the first).
 */
const entryFor = (api: string, file: string): string => `${api} ${file}`;

/** The tokens as one value a store keeps: base64url of their JSON, so no character needs quoting anywhere. */
const sealed = (signIn: SignIn): string =>
  Buffer.from(JSON.stringify({ accessToken: signIn.accessToken, refreshToken: signIn.refreshToken }), 'utf8').toString('base64url');

function unsealed(value: string): { accessToken: string; refreshToken: string } | null {
  const content = parsed(Buffer.from(value, 'base64url').toString('utf8'));
  if (!('value' in content) || typeof content.value !== 'object' || content.value === null) return null;
  const { accessToken, refreshToken } = content.value as Record<string, unknown>;
  return typeof accessToken === 'string' && typeof refreshToken === 'string' ? { accessToken, refreshToken } : null;
}

function asKeptElsewhere(value: unknown, api: string): KeptElsewhere | null {
  if (typeof value !== 'object' || value === null) return null;
  const { clientId, accessTokenExpiresAt, tokensIn } = value as Record<string, unknown>;
  if ((value as Record<string, unknown>).api !== api) return null;
  if (typeof clientId !== 'string' || typeof accessTokenExpiresAt !== 'number' || typeof tokensIn !== 'string') return null;
  return { api, clientId, accessTokenExpiresAt, tokensIn };
}

function asSignIn(value: unknown, api: string): SignIn | null {
  if (typeof value !== 'object' || value === null) return null;
  const { clientId, accessToken, refreshToken, accessTokenExpiresAt } =
    value as Record<string, unknown>;
  if ((value as Record<string, unknown>).api !== api) return null;
  if (
    typeof clientId !== 'string' ||
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof accessTokenExpiresAt !== 'number'
  ) {
    return null;
  }
  return { api, clientId, accessToken, refreshToken, accessTokenExpiresAt };
}

/** What a file holds, or why it could not be read as JSON. */
function parsed(content: string): { value: unknown } | { failure: string } {
  try {
    return { value: JSON.parse(content) };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Where a sign-in is kept (Plan 48b): its tokens in the operating system's
 * credential store when there is one, and the rest in a file readable by its
 * owner only; everything in that file where there is no store. A file is
 * written whole (to a neighbour, then moved into place) so that a crash
 * never leaves half a file.
 */
export class SignInStore {
  constructor(
    private readonly file: string,
    private readonly api: string,
    /** Told when the file exists and cannot be read as a sign-in. */
    private readonly unreadable: (reason: string) => void,
    /** The machine's credential store (`platformSecretStore()`), or null for a file only. Always chosen by the caller. */
    private readonly secrets: SecretStore | null,
    /** Told when the store did not keep the tokens and the file does instead. */
    private readonly say: (line: string) => void = () => undefined
  ) {}

  /** Where the tokens are kept, in words. */
  where(): string {
    return this.secrets?.name ?? FILE_ONLY;
  }

  read(): SignIn | null {
    if (!existsSync(this.file)) return null;
    const content = parsed(readFileSync(this.file, 'utf8'));
    if (!('value' in content)) {
      this.unreadable(content.failure);
      return null;
    }
    // A sign-in kept whole in the file: written where there is no store, or by a connector before 0.5.1.
    const whole = asSignIn(content.value, this.api);
    if (whole) return whole;
    const elsewhere = asKeptElsewhere(content.value, this.api);
    if (!elsewhere) {
      this.unreadable('It is not a sign-in for this CoRoid address');
      return null;
    }
    // A sign-in 0.5.2 kept under the address alone is read there until its next write moves it.
    const kept = this.secrets?.read(this.entry) ?? this.secrets?.read(this.api);
    const tokens = kept ? unsealed(kept) : null;
    if (!tokens) {
      this.unreadable(`Its tokens are not in ${elsewhere.tokensIn}`);
      return null;
    }
    return { api: this.api, clientId: elsewhere.clientId, accessTokenExpiresAt: elsewhere.accessTokenExpiresAt, ...tokens };
  }

  write(signIn: SignIn): void {
    if (this.secrets) {
      const kept = this.keptInStore(signIn, this.secrets);
      if (kept) return this.writeFile({ api: signIn.api, clientId: signIn.clientId, accessTokenExpiresAt: signIn.accessTokenExpiresAt, tokensIn: kept });
    }
    this.writeFile(signIn);
  }

  clear(): void {
    this.secrets?.remove(this.entry);
    rmSync(this.file, { force: true });
  }

  private get entry(): string {
    return entryFor(this.api, this.file);
  }

  /** The store's name when it kept the tokens; null when it did not, and the person is told. */
  private keptInStore(signIn: SignIn, secrets: SecretStore): string | null {
    try {
      secrets.write(this.entry, sealed(signIn));
      // A 0.5.2 entry under the address alone is this sign-in's, read once; it does not stay for another to take.
      secrets.remove(this.api);
      return secrets.name;
    } catch (error) {
      this.say(
        `The sign-in could not be kept in ${secrets.name} (${error instanceof Error ? error.message : String(error)}); it is kept in ${FILE_ONLY}.`
      );
      return null;
    }
  }

  private writeFile(content: SignIn | KeptElsewhere): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const neighbour = `${this.file}.${process.pid}.new`;
    writeFileSync(neighbour, `${JSON.stringify(content, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(neighbour, 0o600);
    renameSync(neighbour, this.file);
  }
}
