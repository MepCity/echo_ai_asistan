import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Higgsfield credentials of the studio gateway.
 *
 * Higgsfield's MCP (https://mcp.higgsfield.ai/mcp) takes an OAuth bearer from
 * its Clerk authorization server (https://higgsfield.ai/_clerk): authorization
 * code + PKCE (S256), dynamic client registration, refresh tokens with the
 * offline_access scope. login.js registers a client once, prints the authorize
 * URL, and takes the redirect URL the user pastes back; this module keeps the
 * tokens in a 0600 JSON file and refreshes them when they are about to expire.
 * Tokens are never logged.
 *
 * HIGGSFIELD_API_KEY (optional) is sent as the bearer instead, for an account
 * that has a key the MCP accepts; Higgsfield documents none (only browser
 * sign-in), so OAuth is the normal path.
 */

export const HIGGSFIELD_AUTH = {
    resource: 'https://mcp.higgsfield.ai/mcp',
    issuer: 'https://higgsfield.ai/_clerk',
    authorization_endpoint: 'https://higgsfield.ai/_clerk/oauth/authorize',
    token_endpoint: 'https://higgsfield.ai/_clerk/oauth/token',
    registration_endpoint: 'https://higgsfield.ai/_clerk/oauth/register',
    scope: 'openid email offline_access',
};

// The browser goes here after consent; nothing listens, the user copies the URL from the address bar.
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8976/callback';
const REFRESH_MARGIN_MS = 120_000;

export const notConnected = () =>
    Object.assign(new Error('Higgsfield is not connected'), {
        userMessage: 'Higgsfield bağlantısı kurulmamış ya da süresi dolmuş; yöneticinin sunucuda girişi yenilemesi gerekiyor.',
        notConnected: true,
    });

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

/** A JSON file written atomically with mode 0600. */
export function createTokenFile(path) {
    return {
        path,
        read() {
            if (!existsSync(path)) return {};
            try {
                return JSON.parse(readFileSync(path, 'utf8')) ?? {};
            } catch {
                return {};
            }
        },
        write(data) {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const tmp = `${path}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
            chmodSync(tmp, 0o600);
            renameSync(tmp, path);
        },
    };
}

async function postForm(fetchImpl, url, form, client) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const body = new URLSearchParams(form);
    if (client?.client_secret && client.token_endpoint_auth_method === 'client_secret_basic') {
        headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
    } else if (client?.client_secret) {
        body.set('client_secret', client.client_secret);
    }
    const response = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    if (!response.ok) {
        // Only the OAuth error code goes into the message, never the body (it could echo a token).
        const code = json?.error ? String(json.error).slice(0, 60) : `HTTP ${response.status}`;
        throw Object.assign(new Error(`token endpoint: ${code}`), { status: response.status, oauthError: json?.error ?? null });
    }
    return json ?? {};
}

const toTokens = (json, previous = {}, now = Date.now()) => ({
    access_token: json.access_token,
    // A server that does not rotate refresh tokens sends none back: keep the one we have.
    refresh_token: json.refresh_token ?? previous.refresh_token ?? null,
    token_type: json.token_type ?? 'Bearer',
    scope: json.scope ?? previous.scope ?? null,
    expires_at: json.expires_in ? now + Number(json.expires_in) * 1000 : null,
    obtained_at: now,
});

/**
 * `file`: createTokenFile(...). `apiKey`: HIGGSFIELD_API_KEY (optional).
 * token() gives a valid bearer (refreshing first when it is close to expiry);
 * refresh() forces a refresh (after a 401).
 */
export function createHiggsfieldAuth({ file, apiKey = null, fetchImpl = globalThis.fetch, now = () => Date.now(), metadata = HIGGSFIELD_AUTH, log = () => {} }) {
    let refreshing = null;

    async function refresh() {
        if (apiKey) throw notConnected();
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const data = file.read();
            if (!data.client?.client_id || !data.tokens?.refresh_token) throw notConnected();
            let json;
            try {
                json = await postForm(
                    fetchImpl,
                    data.metadata?.token_endpoint ?? metadata.token_endpoint,
                    {
                        grant_type: 'refresh_token',
                        refresh_token: data.tokens.refresh_token,
                        client_id: data.client.client_id,
                        ...(metadata.resource ? { resource: metadata.resource } : {}),
                    },
                    data.client,
                );
            } catch (error) {
                log('warn', 'Higgsfield token refresh failed', error.message);
                if (error.oauthError === 'invalid_grant' || error.status === 400 || error.status === 401) {
                    // The grant is gone (revoked or expired): only a new login helps.
                    file.write({ ...data, tokens: { ...data.tokens, access_token: null, refresh_token: null, invalid_since: now() } });
                    throw notConnected();
                }
                throw error;
            }
            if (!json.access_token) throw new Error('token endpoint: no access_token');
            const tokens = toTokens(json, data.tokens, now());
            file.write({ ...data, tokens });
            log('info', 'Higgsfield token refreshed');
            return tokens.access_token;
        })().finally(() => {
            refreshing = null;
        });
        return refreshing;
    }

    return {
        async token() {
            if (apiKey) return apiKey;
            const tokens = file.read().tokens;
            if (tokens?.access_token && (!tokens.expires_at || tokens.expires_at - REFRESH_MARGIN_MS > now())) return tokens.access_token;
            if (!tokens?.refresh_token) throw notConnected();
            return refresh();
        },
        refresh,
        status() {
            if (apiKey) return { connected: true, method: 'api_key' };
            const data = file.read();
            return {
                connected: Boolean(data.tokens?.access_token || data.tokens?.refresh_token),
                method: 'oauth',
                expiresAt: data.tokens?.expires_at ?? null,
                hasRefreshToken: Boolean(data.tokens?.refresh_token),
            };
        },
    };
}

/** Dynamic client registration (RFC 7591) as a public client. */
export async function registerClient({ fetchImpl = globalThis.fetch, metadata = HIGGSFIELD_AUTH, redirectUri = DEFAULT_REDIRECT_URI }) {
    const response = await fetchImpl(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            client_name: 'Echo Studio (Marmara AI)',
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: metadata.scope,
        }),
        signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.client_id) throw new Error(`client registration failed: HTTP ${response.status}${json?.error ? ` ${json.error}` : ''}`);
    return {
        client_id: json.client_id,
        client_secret: json.client_secret ?? null,
        token_endpoint_auth_method: json.token_endpoint_auth_method ?? (json.client_secret ? 'client_secret_post' : 'none'),
        redirect_uri: redirectUri,
        registered_at: new Date().toISOString(),
    };
}

export function authorizeUrl({ client, metadata = HIGGSFIELD_AUTH, challenge, state }) {
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uri,
        scope: metadata.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'consent',
        ...(metadata.resource ? { resource: metadata.resource } : {}),
    }).toString();
    return url.href;
}

/** The code (and state) from what the user pasted: the whole redirect URL, its query, or the bare code. */
export function parsePasted(input) {
    const text = String(input ?? '').trim();
    if (!text) return {};
    try {
        const url = new URL(text);
        return { code: url.searchParams.get('code'), state: url.searchParams.get('state'), error: url.searchParams.get('error') };
    } catch {
        if (text.includes('code=')) {
            const params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
            return { code: params.get('code'), state: params.get('state'), error: params.get('error') };
        }
        return { code: text, state: null };
    }
}

export async function exchangeCode({ fetchImpl = globalThis.fetch, metadata = HIGGSFIELD_AUTH, client, code, verifier, now = Date.now() }) {
    const json = await postForm(
        fetchImpl,
        metadata.token_endpoint,
        {
            grant_type: 'authorization_code',
            code,
            redirect_uri: client.redirect_uri,
            client_id: client.client_id,
            code_verifier: verifier,
            ...(metadata.resource ? { resource: metadata.resource } : {}),
        },
        client,
    );
    if (!json.access_token) throw new Error('token endpoint: no access_token');
    return toTokens(json, {}, now);
}

/** Reads the protected-resource and authorization-server metadata; falls back to the values above. */
export async function discover({ fetchImpl = globalThis.fetch, mcpUrl = HIGGSFIELD_AUTH.resource } = {}) {
    const getJson = async (url) => {
        try {
            const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
            return response.ok ? await response.json() : null;
        } catch {
            return null;
        }
    };
    const origin = new URL(mcpUrl).origin;
    const resource = (await getJson(`${origin}/.well-known/oauth-protected-resource${new URL(mcpUrl).pathname}`)) ?? (await getJson(`${origin}/.well-known/oauth-protected-resource`));
    const issuer = resource?.authorization_servers?.[0] ?? HIGGSFIELD_AUTH.issuer;
    const issuerUrl = new URL(issuer);
    const server =
        (await getJson(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`)) ??
        (await getJson(`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, '')}`)) ??
        {};
    return {
        resource: resource?.resource ?? mcpUrl,
        issuer,
        authorization_endpoint: server.authorization_endpoint ?? HIGGSFIELD_AUTH.authorization_endpoint,
        token_endpoint: server.token_endpoint ?? HIGGSFIELD_AUTH.token_endpoint,
        registration_endpoint: server.registration_endpoint ?? HIGGSFIELD_AUTH.registration_endpoint,
        scope: HIGGSFIELD_AUTH.scope,
    };
}
