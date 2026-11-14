import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the parts of CoRoid a connector talks to, for the
 * connector's tests: the authorization server's register, authorize and
 * token endpoints and the request for work. It keeps what it was asked, and
 * checks what the real one checks (the redirect address, the PKCE verifier,
 * one use of a code, rotation of a refresh token).
 */
export interface FakeCoroid {
  api: string;
  /** Every authorize request, as the browser opened it. */
  authorizations: Array<Record<string, string>>;
  /** Every token request's form. */
  tokenRequests: Array<Record<string, string>>;
  /** Every request for work: the token it carried and its body. */
  polls: Array<{ token: string | null; body: unknown }>;
  /** What the next requests for work are answered with, in order; then 200 with no work. */
  pollAnswers: Array<{ status: number; body?: unknown } | 'drop'>;
  /** What the next refresh requests are answered with instead of new tokens. */
  refreshAnswers: Array<{ status: number; body: unknown } | 'drop'>;
  /** Every report about a turn: which turn, with which token, what it said. */
  turnReports: Array<{ turn: string; token: string | null; events: unknown }>;
  /** What the next reports are answered with, in order; then "continue". */
  turnAnswers: Array<{ status: number; body?: unknown }>;
  /** Every request to a turn's tools: which turn, with which token, for what. */
  toolRequests: Array<{ turn: string; token: string | null; method: string; name: string | null; arguments: unknown }>;
  /** The token the open turn's tools take. */
  turnToken: string;
  /** Marks the access tokens made so far as expired at the request for work. */
  expireAccessTokens(): void;
  /** The code a person's approval would send to the redirect address, for the newest authorization. */
  approve(): { redirect: string };
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startFakeCoroid(): Promise<FakeCoroid> {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  const refreshTokens = new Map<string, { clientId: string; resource: string }>();
  let liveAccessTokens = new Set<string>();
  const fake: Omit<FakeCoroid, 'api' | 'close'> = {
    authorizations: [],
    tokenRequests: [],
    polls: [],
    pollAnswers: [],
    refreshAnswers: [],
    toolRequests: [],
    turnReports: [],
    turnAnswers: [],
    // Made for each stand-in, as CoRoid makes one for each turn.
    turnToken: randomUUID(),
    expireAccessTokens: () => {
      liveAccessTokens = new Set();
    },
    approve: () => {
      const request = fake.authorizations.at(-1);
      if (!request) throw new Error('Nothing asked for approval yet');
      const code = `cmp_code_${randomUUID()}`;
      codes.set(code, {
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        challenge: request.code_challenge,
        resource: request.resource,
      });
      const redirect = new URL(request.redirect_uri);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', request.state);
      return { redirect: redirect.toString() };
    },
  };

  const issue = (clientId: string, resource: string) => {
    const access = `cmp_at_${randomUUID()}`;
    const refresh = `cmp_rt_${randomUUID()}`;
    liveAccessTokens.add(access);
    refreshTokens.set(refresh, { clientId, resource });
    return { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh, scope: 'connector.turns' };
  };

  const server: Server = createServer((request, response) => {
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://fake');
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/oauth/register') {
        const body = JSON.parse(await readBody(request)) as { client_name: string; redirect_uris: string[] };
        const clientId = `coroid_mcp_${randomUUID()}`;
        clients.set(clientId, body.redirect_uris);
        return answer(201, { client_id: clientId, client_name: body.client_name, redirect_uris: body.redirect_uris });
      }
      if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
        const query = Object.fromEntries(url.searchParams.entries());
        if (!clients.get(query.client_id)?.includes(query.redirect_uri)) return answer(400, { error: 'invalid_client' });
        fake.authorizations.push(query);
        response.writeHead(302, { Location: 'https://portal.test/settings/mcp/authorize?request=r1' });
        return response.end();
      }
      if (request.method === 'POST' && url.pathname === '/oauth/token') {
        const form = Object.fromEntries(new URLSearchParams(await readBody(request)).entries());
        fake.tokenRequests.push(form);
        if (form.grant_type === 'authorization_code') {
          const code = codes.get(form.code);
          codes.delete(form.code);
          const verified =
            code !== undefined &&
            code.clientId === form.client_id &&
            code.redirectUri === form.redirect_uri &&
            code.resource === form.resource &&
            createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === code.challenge;
          return verified ? answer(200, issue(form.client_id, form.resource)) : answer(400, { error: 'invalid_grant' });
        }
        const scripted = fake.refreshAnswers.shift();
        if (scripted === 'drop') return request.socket.destroy();
        if (scripted) return answer(scripted.status, scripted.body);
        const known = refreshTokens.get(form.refresh_token);
        refreshTokens.delete(form.refresh_token);
        return known && known.clientId === form.client_id && known.resource === form.resource
          ? answer(200, issue(form.client_id, form.resource))
          : answer(400, { error: 'invalid_grant', error_description: 'Refresh token is invalid' });
      }
      const turnEvents = /^\/connector\/v1\/turns\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === 'POST' && turnEvents) {
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? null;
        const sent = JSON.parse(await readBody(request)) as { events?: unknown };
        fake.turnReports.push({ turn: turnEvents[1], token, events: sent.events });
        const scripted = fake.turnAnswers.shift();
        if (scripted) return answer(scripted.status, scripted.body ?? {});
        if (!token || !liveAccessTokens.has(token)) return answer(401, { error: 'unauthenticated' });
        return answer(200, { action: 'continue' });
      }
      const turnTools = /^\/connector\/v1\/turns\/([^/]+)\/mcp$/.exec(url.pathname);
      if (request.method === 'POST' && turnTools) {
        const call = JSON.parse(await readBody(request)) as { id: number; method: string; params?: { name?: string; arguments?: unknown } };
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? null;
        fake.toolRequests.push({ turn: turnTools[1], token, method: call.method, name: call.params?.name ?? null, arguments: call.params?.arguments ?? null });
        if (token !== fake.turnToken) return answer(401, { jsonrpc: '2.0', id: call.id, error: { code: -32001, message: 'This turn is closed' } });
        if (call.method === 'tools/list') {
          return answer(200, { jsonrpc: '2.0', id: call.id, result: { tools: [{ name: 'read_file', inputSchema: { type: 'object' } }, { name: 'report_qa_verdict', inputSchema: { type: 'object' } }] } });
        }
        return answer(200, { jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text: `${call.params?.name} done` }], isError: false } });
      }
      if (request.method === 'POST' && url.pathname === '/connector/v1/poll') {
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? null;
        fake.polls.push({ token, body: JSON.parse((await readBody(request)) || 'null') });
        const scripted = fake.pollAnswers.shift();
        if (scripted === 'drop') return request.socket.destroy();
        if (scripted) return answer(scripted.status, scripted.body ?? {});
        if (!token || !liveAccessTokens.has(token)) return answer(401, { error: 'unauthenticated' });
        return answer(200, { turn: null, pollAfterSeconds: 15 });
      }
      return answer(404, { error: 'not_found' });
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...fake,
    get authorizations() { return fake.authorizations; },
    get tokenRequests() { return fake.tokenRequests; },
    get polls() { return fake.polls; },
    get pollAnswers() { return fake.pollAnswers; },
    get refreshAnswers() { return fake.refreshAnswers; },
    get toolRequests() { return fake.toolRequests; },
    get turnReports() { return fake.turnReports; },
    get turnAnswers() { return fake.turnAnswers; },
    api: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
