import { OAuthRefusal, refreshTokens } from './oauth.js';
import type { SignIn, SignInStore } from './store.js';

/** CoRoid has ended this machine's sign-in (it was disconnected), or there never was one. */
export class SignedOut extends Error {
  constructor() {
    super('This machine is not signed in to CoRoid');
    this.name = 'SignedOut';
  }
}

/** An access token is renewed when it has less than this left. */
const RENEW_BEFORE_MS = 60_000;

/**
 * The connector's sign-in while it runs. An access token lasts a quarter of
 * an hour. The refresh token that renews it is replaced at every use, and
 * CoRoid ends the sign-in when an old one is used again, so: one renewal at
 * a time, and the new refresh token is saved before anything uses the new
 * access token.
 */
export class Session {
  private current: SignIn | null;
  private renewing: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly store: SignInStore,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.current = store.read();
  }

  /** A token CoRoid should still take. */
  async accessToken(): Promise<string> {
    if (!this.current) throw new SignedOut();
    return this.current.accessTokenExpiresAt - this.now() > RENEW_BEFORE_MS
      ? this.current.accessToken
      : this.renew();
  }

  /** A new access token, whatever the old one's age: for when CoRoid refused it. */
  renew(): Promise<string> {
    this.renewing ??= this.renewed().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async renewed(): Promise<string> {
    const spent = this.current;
    if (!spent) throw new SignedOut();
    let tokens;
    try {
      tokens = await refreshTokens(spent.api, spent);
    } catch (error) {
      // Only this answer means the sign-in is over. Anything else (no network, CoRoid switched off) keeps it.
      if (error instanceof OAuthRefusal && error.code === 'invalid_grant') {
        this.current = null;
        this.store.clear();
        throw new SignedOut();
      }
      throw error;
    }
    const next: SignIn = {
      api: spent.api,
      clientId: spent.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: this.now() + tokens.expiresInSeconds * 1000,
    };
    this.store.write(next);
    this.current = next;
    return next.accessToken;
  }
}
