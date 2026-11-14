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
 * The file a sign-in is kept in: readable by its owner only, and written
 * whole (to a neighbour, then moved into place) so that a crash never leaves
 * half a file.
 */
export class SignInStore {
  constructor(
    private readonly file: string,
    private readonly api: string,
    /** Told when the file exists and cannot be read as a sign-in. */
    private readonly unreadable: (reason: string) => void = () => undefined
  ) {}

  read(): SignIn | null {
    if (!existsSync(this.file)) return null;
    const content = parsed(readFileSync(this.file, 'utf8'));
    const signIn = 'value' in content ? asSignIn(content.value, this.api) : null;
    if (!signIn) {
      this.unreadable(
        'failure' in content
          ? content.failure
          : 'It is not a sign-in for this CoRoid address'
      );
    }
    return signIn;
  }

  write(signIn: SignIn): void {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const neighbour = `${this.file}.${process.pid}.new`;
    writeFileSync(neighbour, `${JSON.stringify(signIn, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(neighbour, 0o600);
    renameSync(neighbour, this.file);
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
