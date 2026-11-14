import { createHash, randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authorizeUrl, exchangeCode, registerClient } from './oauth.js';
import type { SignIn } from './store.js';

const page = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem"><h1>${title}</h1><p>${line}</p>`;

const answer = (response: ServerResponse, status: number, html: string): void => {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
};

/**
 * Signs this machine in to CoRoid. The connector registers itself, opens
 * CoRoid's approval page in the person's browser and waits, on this machine
 * only, for the browser to come back with a code. The code is worth nothing
 * without the secret this process keeps (PKCE), and an answer is taken only
 * with the state this process made.
 */
export async function signIn(options: {
  api: string;
  machineName: string;
  /** Opens the approval page. A browser in real use; a failure here ends the sign-in. */
  open: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<SignIn> {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const clientId = await registerClient(
      options.api,
      `CoRoid connector on ${options.machineName}`,
      redirectUri
    );
    const tokens = await new Promise<Awaited<ReturnType<typeof exchangeCode>>>(
      (resolve, reject) => {
        const unanswered = setTimeout(
          () => reject(new Error('No answer from the browser. Start the connector again to sign in.')),
          options.timeoutMs ?? 10 * 60_000
        );
        const settle = (finish: () => void): void => {
          clearTimeout(unanswered);
          finish();
        };

        server.on('request', (request, response) => {
          const url = new URL(request.url ?? '/', redirectUri);
          // Only the answer to this sign-in: the state this process made, on the path it named.
          if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
            return answer(response, 400, page('Not this sign-in', 'This page does not belong to the sign-in that is waiting.'));
          }
          const code = url.searchParams.get('code');
          if (!code) {
            answer(response, 200, page('Not connected', 'The sign-in was not approved. You can close this tab.'));
            return settle(() => reject(new Error('The sign-in was not approved in CoRoid.')));
          }
          exchangeCode(options.api, { clientId, redirectUri, code, verifier }).then(
            exchanged => {
              answer(response, 200, page('This machine is connected', 'You can close this tab.'));
              settle(() => resolve(exchanged));
            },
            (error: unknown) => {
              answer(response, 502, page('Not connected', 'CoRoid did not accept the sign-in. See the terminal.'));
              settle(() => reject(error));
            }
          );
        });

        const url = authorizeUrl(options.api, { clientId, redirectUri, challenge, state });
        Promise.resolve()
          .then(() => options.open(url))
          .catch((error: unknown) => settle(() => reject(error)));
      }
    );
    return {
      api: options.api,
      clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: Date.now() + tokens.expiresInSeconds * 1000,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
