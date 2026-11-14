import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Session, SignedOut } from './session.js';
import { SignInStore, storeFileFor, type SignIn } from './store.js';
import { startFakeCoroid, type FakeCoroid } from './test-utils/fake-coroid.js';

/**
 * Plan 47 Phase 3: the connector keeps its sign-in. An access token lasts a
 * quarter of an hour; the refresh token that renews it is replaced at every
 * use, and using an old one again ends the sign-in on CoRoid's side.
 *
 * Failure modes, written before the code:
 * T1 the file with the sign-in can be read by other users of the machine;
 * T2 a renewed refresh token is used before it is saved, so a crash leaves
 *    the old, already spent one in the file and the next start ends the
 *    sign-in;
 * T3 two requests renew at the same moment and one of them spends a refresh
 *    token twice;
 * T4 an access token is used after it ran out, or renewed on every request;
 * T5 a sign-in CoRoid has ended (the machine was disconnected) stays in the
 *    file, and the connector goes on trying for ever;
 * T6 a network failure, or CoRoid being switched off for a while, is taken
 *    for the end of the sign-in and the file is wiped;
 * T7 a sign-in for another CoRoid address is used, or a file that is not a
 *    sign-in is.
 */
let coroid: FakeCoroid;
let home: string;
const NOW = 1_800_000_000_000;
const VERIFIER = 'a-verifier-for-the-session-tests-0123456789';

beforeEach(async () => {
  coroid = await startFakeCoroid();
  home = mkdtempSync(join(tmpdir(), 'coroid-connector-home-'));
});
afterEach(async () => {
  await coroid.close();
  rmSync(home, { recursive: true, force: true });
});

/** A sign-in the fake CoRoid knows, as `signIn` would have left it. */
async function signedIn(expiresInSeconds: number): Promise<{ store: SignInStore; first: SignIn }> {
  const registered = (await (
    await fetch(`${coroid.api}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Connector', redirect_uris: ['http://127.0.0.1:1/callback'] }),
    })
  ).json()) as { client_id: string };
  await fetch(
    `${coroid.api}/oauth/authorize?${new URLSearchParams({
      client_id: registered.client_id, redirect_uri: 'http://127.0.0.1:1/callback', state: 's',
      code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'), resource: `${coroid.api}/connector`,
    }).toString()}`,
    { redirect: 'manual' }
  );
  const code = new URL(coroid.approve().redirect).searchParams.get('code') ?? '';
  const tokens = (await (
    await fetch(`${coroid.api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: registered.client_id,
        redirect_uri: 'http://127.0.0.1:1/callback', code_verifier: VERIFIER,
        resource: `${coroid.api}/connector`,
      }).toString(),
    })
  ).json()) as { access_token: string; refresh_token: string };
  const first: SignIn = {
    api: coroid.api,
    clientId: registered.client_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: NOW + expiresInSeconds * 1000,
  };
  const store = new SignInStore(storeFileFor(home, coroid.api), coroid.api, () => undefined, null);
  store.write(first);
  return { store, first };
}
const refreshes = () => coroid.tokenRequests.filter(form => form.grant_type === 'refresh_token');

describe('the connector keeps its sign-in', () => {
  it('T1, T7: the sign-in is kept where only its owner reads it, and only for the address it was made for', async () => {
    const { store, first } = await signedIn(900);
    const file = storeFileFor(home, coroid.api);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(store.read()).toEqual(first);

    expect(new SignInStore(file, 'https://api.elsewhere.test', () => undefined, null).read()).toBeNull();
    expect(storeFileFor(home, 'https://api.elsewhere.test')).not.toBe(file);
    writeFileSync(file, '{"api":"' + coroid.api + '","refreshToken":42}');
    expect(store.read()).toBeNull();
    writeFileSync(file, 'not json');
    expect(store.read()).toBeNull();
  });

  it('T4: an access token is used while it lasts and renewed shortly before it runs out', async () => {
    const { store, first } = await signedIn(900);
    let now = NOW;
    const session = new Session(store, { now: () => now });
    expect(await session.accessToken()).toBe(first.accessToken);
    now = NOW + 800_000;
    expect(await session.accessToken()).toBe(first.accessToken);
    expect(refreshes()).toHaveLength(0);

    now = NOW + 850_000;
    const renewed = await session.accessToken();
    expect(renewed).not.toBe(first.accessToken);
    expect(refreshes()).toHaveLength(1);
    expect(await session.accessToken()).toBe(renewed);
    expect(refreshes()).toHaveLength(1);
  });

  it('T2: the new refresh token is in the file before anything uses the new access token', async () => {
    const { store, first } = await signedIn(900);
    const session = new Session(store, { now: () => NOW });
    const renewed = await session.renew();
    const saved = JSON.parse(readFileSync(storeFileFor(home, coroid.api), 'utf8')) as SignIn;
    expect(saved.accessToken).toBe(renewed);
    expect(saved.refreshToken).not.toBe(first.refreshToken);
    expect(saved.accessTokenExpiresAt).toBe(NOW + 900_000);
    // What is in the file renews again: a restart loses nothing.
    const restarted = new Session(new SignInStore(storeFileFor(home, coroid.api), coroid.api, () => undefined, null), { now: () => NOW });
    expect(await restarted.renew()).toMatch(/^cmp_at_/);
  });

  it('T3: requests that renew at the same moment share one renewal', async () => {
    const { store } = await signedIn(10);
    const session = new Session(store, { now: () => NOW });
    const tokens = await Promise.all([session.accessToken(), session.accessToken(), session.renew()]);
    expect(new Set(tokens).size).toBe(1);
    expect(refreshes()).toHaveLength(1);
  });

  it('T5: a sign-in CoRoid ended is forgotten, and the connector is told it is signed out', async () => {
    const { store } = await signedIn(900);
    coroid.refreshAnswers.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token is invalid' } });
    const session = new Session(store, { now: () => NOW });
    await expect(session.renew()).rejects.toBeInstanceOf(SignedOut);
    expect(store.read()).toBeNull();
    await expect(session.accessToken()).rejects.toBeInstanceOf(SignedOut);
    expect(refreshes()).toHaveLength(1);
  });

  it('T6: a failure that is not the end of the sign-in keeps it', async () => {
    const { store, first } = await signedIn(900);
    const session = new Session(store, { now: () => NOW });
    coroid.refreshAnswers.push('drop', { status: 503, body: { error: 'temporarily_unavailable' } }, { status: 400, body: { error: 'invalid_target' } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await session.renew().then(
        () => null,
        (error: unknown) => error
      );
      expect(failed).not.toBeNull();
      expect(failed).not.toBeInstanceOf(SignedOut);
      expect(store.read()).toEqual(first);
    }
    expect(await session.renew()).toMatch(/^cmp_at_/);
  });
});
