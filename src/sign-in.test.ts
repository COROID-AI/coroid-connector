import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { signIn } from './sign-in.js';
import { startFakeCoroid, type FakeCoroid } from './test-utils/fake-coroid.js';

/**
 * Plan 47 Phase 3: the connector signs in. It opens CoRoid's approval page
 * in the person's browser and waits on this machine for the answer.
 *
 * Failure modes, written before the code:
 * C1 an answer with a state the connector did not make finishes the sign-in
 *    (any page on the machine could then hand the connector a code of its
 *    own);
 * C2 the code is exchanged without the secret only this connector has (the
 *    PKCE verifier), or for another redirect address;
 * C3 the connector asks for CoRoid MCP's resource or scopes instead of its
 *    own;
 * C4 the address that waits for the answer is reachable from other machines;
 * C5 a person who refuses leaves the connector waiting, or its port open;
 * C6 nobody answers and the connector waits for ever;
 * C7 the port stays open after a sign-in;
 * C8 the machine's name is not what the person will see on the approval
 *    page.
 */
let coroid: FakeCoroid;
beforeEach(async () => {
  coroid = await startFakeCoroid();
});
afterEach(() => coroid.close());

const portOf = (url: string): number => Number(new URL(url).port);
const open = (port: number, host: string): Promise<boolean> =>
  new Promise(resolve => {
    const socket = createConnection({ port, host, timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });

describe('the connector signs in', () => {
  it('C2, C3, C7, C8: asks for its own resource and scope, proves the code is its own, and closes its port', async () => {
    let waitingOn = 0;
    const signedIn = await signIn({
      api: coroid.api,
      machineName: 'Ada’s laptop',
      open: async url => {
        expect(new URL(url).origin).toBe(coroid.api);
        await fetch(url, { redirect: 'manual' });
        const { redirect } = coroid.approve();
        waitingOn = portOf(redirect);
        const page = await fetch(redirect);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('close this tab');
      },
    });

    const asked = coroid.authorizations[0];
    expect(asked).toMatchObject({
      response_type: 'code',
      resource: `${coroid.api}/connector`,
      scope: 'connector.turns',
      code_challenge_method: 'S256',
    });
    expect(new URL(asked.redirect_uri).hostname).toBe('127.0.0.1');
    expect(asked.state.length).toBeGreaterThanOrEqual(32);
    expect(coroid.tokenRequests[0]).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: asked.redirect_uri,
      resource: `${coroid.api}/connector`,
    });
    expect(signedIn).toMatchObject({ api: coroid.api, clientId: asked.client_id });
    expect(signedIn.accessToken).toMatch(/^cmp_at_/);
    expect(signedIn.refreshToken).toMatch(/^cmp_rt_/);
    expect(signedIn.accessTokenExpiresAt).toBeGreaterThan(Date.now());
    expect(await open(waitingOn, '127.0.0.1')).toBe(false);
  });

  it('C1: an answer with another state is refused and the sign-in goes on waiting for the right one', async () => {
    const signedIn = await signIn({
      api: coroid.api,
      machineName: 'Ada’s laptop',
      open: async url => {
        await fetch(url, { redirect: 'manual' });
        const { redirect } = coroid.approve();
        const forged = new URL(redirect);
        forged.searchParams.set('state', 'a-state-someone-else-made');
        forged.searchParams.set('code', 'cmp_code_of-someone-else');
        expect((await fetch(forged)).status).toBe(400);
        const stateless = new URL(redirect);
        stateless.searchParams.delete('state');
        expect((await fetch(stateless)).status).toBe(400);
        expect(coroid.tokenRequests).toEqual([]);
        expect((await fetch(redirect)).status).toBe(200);
      },
    });
    expect(signedIn.accessToken).toMatch(/^cmp_at_/);
    expect(coroid.tokenRequests).toHaveLength(1);
  });

  it('C4: only this machine can reach the address that waits for the answer', async () => {
    const others = Object.values(networkInterfaces())
      .flatMap(addresses => addresses ?? [])
      .filter(address => address.family === 'IPv4' && !address.internal)
      .map(address => address.address);
    await signIn({
      api: coroid.api,
      machineName: 'Ada’s laptop',
      open: async url => {
        await fetch(url, { redirect: 'manual' });
        const { redirect } = coroid.approve();
        const port = portOf(redirect);
        expect(await open(port, '127.0.0.1')).toBe(true);
        for (const address of others) expect([address, await open(port, address)]).toEqual([address, false]);
        await fetch(redirect);
      },
    });
  });

  it('C5: a refusal ends the sign-in and closes the port', async () => {
    let waitingOn = 0;
    const refused = signIn({
      api: coroid.api,
      machineName: 'Ada’s laptop',
      open: async url => {
        await fetch(url, { redirect: 'manual' });
        const denied = new URL(coroid.approve().redirect);
        waitingOn = Number(denied.port);
        denied.searchParams.delete('code');
        denied.searchParams.set('error', 'access_denied');
        await fetch(denied);
      },
    });
    await expect(refused).rejects.toThrow(/not approved/);
    expect(coroid.tokenRequests).toEqual([]);
    expect(await open(waitingOn, '127.0.0.1')).toBe(false);
  });

  it('C6: with no answer the sign-in gives up and closes the port', async () => {
    let waitingOn = 0;
    const unanswered = signIn({
      api: coroid.api,
      machineName: 'Ada’s laptop',
      timeoutMs: 300,
      open: async url => {
        await fetch(url, { redirect: 'manual' });
        waitingOn = portOf(coroid.authorizations[0].redirect_uri);
      },
    });
    await expect(unanswered).rejects.toThrow(/no answer/i);
    expect(await open(waitingOn, '127.0.0.1')).toBe(false);
  });
});
