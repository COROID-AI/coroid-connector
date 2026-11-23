import {
  CONNECTOR_RESOURCE_PATH,
  CONNECTOR_SCOPE,
} from './protocol/local-agents.js';

const OAUTH_TIMEOUT_MS = 30_000;

/**
 * What the connector asks of CoRoid's authorization server (the one that
 * also signs MCP clients in): a client of its own, an approval page, and
 * tokens for the connector's address with the connector's one scope.
 */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

/** CoRoid answered and refused. `code` is the OAuth error, e.g. invalid_grant. */
export class OAuthRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'OAuthRefusal';
  }
}

export const connectorResource = (api: string): string =>
  `${api}${CONNECTOR_RESOURCE_PATH}`;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function safeParseJson(raw: string): unknown {
  if (!raw.trimStart().startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function answered(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  const body = safeParseJson(raw);
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  if (!response.ok) {
    const code = text(record.error) ?? `http_${response.status}`;
    throw new OAuthRefusal(
      response.status,
      code,
      text(record.error_description) ?? `CoRoid refused the request (${code})`
    );
  }
  return record;
}

function tokensOf(record: Record<string, unknown>): Tokens {
  const accessToken = text(record.access_token);
  const refreshToken = text(record.refresh_token);
  if (!accessToken || !refreshToken || typeof record.expires_in !== 'number') {
    throw new OAuthRefusal(200, 'invalid_response', 'CoRoid sent no tokens');
  }
  return { accessToken, refreshToken, expiresInSeconds: record.expires_in };
}

const tokenRequest = async (
  api: string,
  form: Record<string, string>
): Promise<Tokens> =>
  tokensOf(
    await answered(
      await fetch(`${api}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      })
    )
  );

/** Registers this connector as a client; its name is what the approval page shows. */
export async function registerClient(
  api: string,
  clientName: string,
  redirectUri: string
): Promise<string> {
  const record = await answered(
    await fetch(`${api}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
      }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    })
  );
  const clientId = text(record.client_id);
  if (!clientId) {
    throw new OAuthRefusal(200, 'invalid_response', 'CoRoid sent no client');
  }
  return clientId;
}

/** The approval page for this connector, to open in the person's browser. */
export function authorizeUrl(
  api: string,
  input: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string;
  }
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    resource: connectorResource(api),
    scope: CONNECTOR_SCOPE,
  });
  return `${api}/oauth/authorize?${query.toString()}`;
}

export const exchangeCode = (
  api: string,
  input: {
    clientId: string;
    redirectUri: string;
    code: string;
    verifier: string;
  }
): Promise<Tokens> =>
  tokenRequest(api, {
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: connectorResource(api),
  });

export const refreshTokens = (
  api: string,
  input: { clientId: string; refreshToken: string }
): Promise<Tokens> =>
  tokenRequest(api, {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: connectorResource(api),
  });
