import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY = 256 * 1024;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Constant-time comparison of a presented bearer with the shared secret. */
export function bearerMatches(header, secret) {
    if (!secret) return false;
    const match = String(header ?? '').match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const given = createHash('sha256').update(match[1].trim()).digest();
    const expected = createHash('sha256').update(secret).digest();
    return timingSafeEqual(given, expected);
}

/**
 * The studio gateway as an MCP server over Streamable HTTP, stateless:
 * POST /mcp takes a JSON-RPC message (or a batch) and answers with JSON.
 * Every request needs `Authorization: Bearer <ECHO_STUDIO_TOKEN>` (Hermes
 * sends it from its mcp_servers headers). GET /health is open (no details).
 * POST /approval-hint {tool, arguments} (same bearer) answers what the WhatsApp approval card shows
 * before a studio tool runs ({ credits, aspect_ratio, ... }); it records nothing and never calls
 * Higgsfield (Hermes' echo_onay_tr plugin asks it).
 */
export function createStudioServer({ gateway, token, log = () => {}, name = 'echo-studio', version = '1.0.0' }) {
    if (!token || String(token).length < 16) throw new Error('ECHO_STUDIO_TOKEN must be set (at least 16 characters)');

    const listed = gateway.tools.map(({ name: toolName, description, inputSchema, annotations }) => ({ name: toolName, description, inputSchema, annotations }));

    async function handleMessage(message) {
        const isRequest = message && typeof message === 'object' && message.id !== undefined && message.id !== null;
        const reply = (result) => (isRequest ? { jsonrpc: '2.0', id: message.id, result } : null);
        const fail = (code, text) => (isRequest ? { jsonrpc: '2.0', id: message.id, error: { code, message: text } } : null);
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
        }
        switch (message.method) {
            case 'initialize': {
                const asked = message.params?.protocolVersion;
                return reply({
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name, version },
                    instructions: 'Marmara AI stüdyosu: görsel ve ses üretimi (kredi harcar). Önce get_brand_kit; her üretim tek seferdir, kendiliğinden tekrar deneme.',
                });
            }
            case 'ping':
                return reply({});
            case 'tools/list':
                return reply({ tools: listed });
            case 'tools/call': {
                const toolName = message.params?.name;
                try {
                    const { text, isError } = await gateway.callTool(toolName, message.params?.arguments ?? {});
                    return reply({ content: [{ type: 'text', text }], isError });
                } catch (error) {
                    if (error.unknownTool) return fail(-32602, `Unknown tool: ${toolName}`);
                    log('error', 'studio call failed', error.message);
                    return fail(-32603, 'Internal error');
                }
            }
            default:
                if (message.method.startsWith('notifications/')) return null;
                return fail(-32601, `Method not found: ${message.method}`);
        }
    }

    const send = (response, status, body, headers = {}) => {
        response.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    async function handle(request, response) {
        const path = new URL(request.url, 'http://studio').pathname.replace(/\/+$/, '') || '/';
        if (path === '/health' && request.method === 'GET') return send(response, 200, { ok: true });
        if (path !== '/mcp' && path !== '/approval-hint') return send(response, 404, 'not found');
        if (!bearerMatches(request.headers.authorization, token)) {
            log('warn', 'studio request without a valid bearer rejected');
            return send(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        }
        if (path === '/approval-hint') {
            if (request.method !== 'POST') return send(response, 405, 'method not allowed', { Allow: 'POST' });
            let hintBody;
            try {
                hintBody = JSON.parse((await readBody(request, 16 * 1024)) ?? '');
            } catch {
                return send(response, 400, { error: 'bad request' });
            }
            const args = hintBody?.arguments && typeof hintBody.arguments === 'object' ? hintBody.arguments : {};
            return send(response, 200, gateway.approvalHint ? gateway.approvalHint(String(hintBody?.tool ?? ''), args) : {});
        }
        if (request.method === 'DELETE') return send(response, 200, 'ok');
        if (request.method !== 'POST') return send(response, 405, 'method not allowed', { Allow: 'POST, DELETE' });

        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > MAX_BODY) return send(response, 413, 'too large');
            chunks.push(chunk);
        }
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            return send(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        }
        if (Array.isArray(body)) {
            const answers = (await Promise.all(body.map(handleMessage))).filter(Boolean);
            return answers.length ? send(response, 200, answers) : send(response, 202, '');
        }
        const answer = await handleMessage(body);
        return answer ? send(response, 200, answer) : send(response, 202, '');
    }

    /** The request body as text, or null when it is larger than `max`. */
    async function readBody(request, max) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > max) return null;
            chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    const server = createServer((request, response) => {
        handle(request, response).catch((error) => {
            log('error', 'studio request failed', error.message);
            if (!response.headersSent) send(response, 500, 'error');
        });
    });
    // A generation can take minutes; Node's default request timeout (5 min) is kept, keep-alive is lengthened.
    server.keepAliveTimeout = 65_000;
    return server;
}
