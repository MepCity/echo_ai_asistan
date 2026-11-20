import { HIGGSFIELD_TOOLS } from './config.js';

/**
 * A small MCP client for Higgsfield's Streamable HTTP server
 * (https://mcp.higgsfield.ai/mcp): JSON-RPC over POST, answers as JSON or as
 * an SSE stream, the session in Mcp-Session-Id. Only the tools in
 * HIGGSFIELD_TOOLS can be called; any other name throws before anything is
 * sent. A 401 gets one token refresh and one retry (the server did nothing);
 * a lost session is opened again once. Nothing else is retried: a generation
 * whose answer is lost is never sent twice.
 *
 * `auth.token()` returns the bearer; `auth.refresh()` forces a new one.
 */
export function createHiggsfieldClient({ url, auth, fetchImpl = globalThis.fetch, timeoutMs = 60_000, clientName = 'echo-studio' }) {
    let session = null;
    let initialized = false;
    let initializing = null;
    let nextId = 1;

    async function post(body, { sessionId = session, token } = {}) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token ?? (await auth.token())}`,
            'MCP-Protocol-Version': '2025-06-18',
        };
        if (sessionId) headers['Mcp-Session-Id'] = sessionId;
        const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        return response;
    }

    async function readResponse(response, id) {
        const type = response.headers.get('content-type') ?? '';
        const text = await response.text();
        if (!text) return null;
        if (type.includes('text/event-stream')) {
            for (const event of text.split(/\r?\n\r?\n/)) {
                const data = event
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n');
                if (!data) continue;
                let message;
                try {
                    message = JSON.parse(data);
                } catch {
                    continue;
                }
                if (message.id === id && ('result' in message || 'error' in message)) return message;
            }
            return null;
        }
        return JSON.parse(text);
    }

    const httpError = (response, what) => Object.assign(new Error(`Higgsfield ${what}: HTTP ${response.status}`), { status: response.status });

    async function rpc(method, params, { retried = false } = {}) {
        if (method !== 'initialize') await ensureSession();
        const id = nextId++;
        let response = await post({ jsonrpc: '2.0', id, method, params });
        if (response.status === 401 && !retried) {
            await auth.refresh();
            if (method === 'initialize') return rpc(method, params, { retried: true });
            resetSession();
            await ensureSession();
            return rpc(method, params, { retried: true });
        }
        if (response.status === 404 && session && !retried && method !== 'initialize') {
            // The server forgot the session: open a new one (nothing was done with this request).
            resetSession();
            await ensureSession();
            return rpc(method, params, { retried: true });
        }
        if (response.status === 401) throw Object.assign(httpError(response, method), { unauthorized: true });
        if (!response.ok) throw httpError(response, method);
        if (method === 'initialize') session = response.headers.get('mcp-session-id') ?? null;
        const message = await readResponse(response, id);
        if (!message) throw new Error(`Higgsfield ${method}: no answer`);
        if (message.error) throw Object.assign(new Error(`Higgsfield ${method}: ${message.error.message ?? 'error'}`), { rpcError: message.error });
        return message.result;
    }

    async function ensureSession() {
        if (initialized) return;
        if (initializing) return initializing;
        initializing = (async () => {
            await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1.0.0' } });
            initialized = true;
            const response = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
            await response.text().catch(() => {});
        })().finally(() => {
            initializing = null;
        });
        return initializing;
    }
    const resetSession = () => {
        session = null;
        initialized = false;
    };

    return {
        /** Calls one allowed tool; returns { text, structured, isError }. */
        async call(name, args = {}) {
            if (!HIGGSFIELD_TOOLS.has(name)) throw Object.assign(new Error(`Higgsfield tool ${name} is not allowed`), { notAllowed: true });
            let result;
            try {
                result = await rpc('tools/call', { name, arguments: args });
            } catch (error) {
                if (error.status === 404) resetSession();
                throw error;
            }
            const text = (result?.content ?? [])
                .filter((part) => part?.type === 'text')
                .map((part) => part.text)
                .join('\n');
            return { text, structured: result?.structuredContent ?? null, isError: Boolean(result?.isError) };
        },
        reset: resetSession,
    };
}

/** Splits one CSV row (double quotes, "" escapes). */
function splitRow(line) {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quoted) {
            if (char === '"' && line[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (char === '"') quoted = false;
            else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ',') {
            cells.push(cell);
            cell = '';
        } else cell += char;
    }
    cells.push(cell);
    return cells.map((value) => value.trim());
}

/**
 * Reads Higgsfield's compact text answers: tables like
 *   jobs[1]{index,job_id,status,result_url}:
 *     0,cb29…,completed,"https://…"
 * and "key: value" lines (also indented, as in "summary:"). Returns
 * { tables: { jobs: [ {index, job_id, …} ] }, values: { all_terminal: 'true', … } }.
 */
export function parseCompact(text) {
    const tables = {};
    const values = {};
    const lines = String(text ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const header = lines[i].match(/^\s*([A-Za-z_][\w]*)\[(\d+)\]\{([^}]*)\}:\s*$/);
        if (header) {
            const [, name, count, fields] = header;
            const keys = fields.split(',').map((key) => key.trim());
            const rows = [];
            for (let n = 0; n < Number(count) && i + 1 < lines.length; n++) {
                i++;
                const cells = splitRow(lines[i].trim());
                rows.push(Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ''])));
            }
            tables[name] = rows;
            continue;
        }
        const pair = lines[i].match(/^\s*([A-Za-z_][\w]*):\s*(.+?)\s*$/);
        if (pair && values[pair[1]] === undefined) values[pair[1]] = pair[2].replace(/^"(.*)"$/, '$1');
    }
    return { tables, values };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Every object (depth-first) inside a structured answer. */
function* objects(value) {
    if (Array.isArray(value)) for (const item of value) yield* objects(item);
    else if (value && typeof value === 'object') {
        yield value;
        for (const item of Object.values(value)) yield* objects(item);
    }
}

/** The credits of an estimate ("Cost preflight for x: 2.75 credits (2.75 exact)."), or null. */
export function parseCredits({ text, structured }) {
    for (const object of objects(structured)) {
        for (const key of ['credits', 'cost', 'total_credits', 'estimated_credits', 'price']) {
            const value = Number(object[key]);
            if (object[key] !== undefined && object[key] !== null && Number.isFinite(value)) return Math.abs(value);
        }
    }
    const exact = String(text ?? '').match(/\(([\d.]+)\s*exact\)/i);
    if (exact) return Number(exact[1]);
    const match = String(text ?? '').match(/([\d]+(?:\.\d+)?)\s*credits?/i);
    return match ? Number(match[1]) : null;
}

/** The job ids a generate_* answer names. */
export function parseJobIds({ text, structured }) {
    const ids = [];
    for (const object of objects(structured)) {
        const id = object.job_id ?? object.jobId ?? (Array.isArray(object.job_ids) ? null : null);
        if (typeof id === 'string' && UUID.test(id)) ids.push(id);
        if (Array.isArray(object.job_ids)) ids.push(...object.job_ids.filter((item) => typeof item === 'string' && UUID.test(item)));
    }
    if (!ids.length) {
        const { tables, values } = parseCompact(text);
        for (const rows of Object.values(tables)) {
            for (const row of rows) {
                const id = row.job_id ?? row.id;
                if (id && UUID.test(id)) ids.push(id.match(UUID)[0]);
            }
        }
        if (!ids.length && values.job_id && UUID.test(values.job_id)) ids.push(values.job_id.match(UUID)[0]);
    }
    if (!ids.length) {
        const match = String(text ?? '').match(new RegExp(`job[_ ]?id[^0-9a-f]{0,6}(${UUID.source})`, 'i'));
        if (match) ids.push(match[1]);
    }
    return [...new Set(ids)];
}

/** One job's state from a jobs_wait answer: { status, url, error, terminal }. */
export function parseJob({ text, structured }, jobId) {
    let row = null;
    for (const object of objects(structured)) {
        if ((object.job_id ?? object.id) === jobId && (object.status || object.result_url || object.url)) {
            row = object;
            break;
        }
    }
    if (!row) {
        const { tables } = parseCompact(text);
        for (const rows of Object.values(tables)) {
            row = rows.find((item) => (item.job_id ?? item.id) === jobId) ?? row;
        }
    }
    const status = String(row?.status ?? '').toLowerCase();
    const urlField = row?.result_url ?? row?.url ?? (Array.isArray(row?.results) ? row.results[0]?.url ?? row.results[0] : null);
    const url = typeof urlField === 'string' && urlField.startsWith('https://') ? urlField : null;
    const terminal = ['completed', 'failed', 'nsfw', 'ip_detected', 'canceled', 'cancelled', 'error'].includes(status);
    return { status: status || 'unknown', url, error: row?.error || null, terminal };
}

/** The presigned upload of a media_upload answer: { mediaId, uploadUrl }. */
export function parseUpload({ text, structured }) {
    for (const object of objects(structured)) {
        const uploadUrl = object.upload_url ?? object.uploadUrl;
        const mediaId = object.media_id ?? object.id;
        if (uploadUrl && mediaId) return { mediaId: String(mediaId), uploadUrl: String(uploadUrl) };
    }
    const { tables, values } = parseCompact(text);
    for (const rows of Object.values(tables)) {
        for (const row of rows) {
            const uploadUrl = row.upload_url;
            const mediaId = row.media_id ?? row.id;
            if (uploadUrl && mediaId) return { mediaId, uploadUrl };
        }
    }
    if (values.upload_url && (values.media_id || values.id)) return { mediaId: values.media_id ?? values.id, uploadUrl: values.upload_url };
    const url = String(text ?? '').match(/https:\/\/\S+/);
    const id = String(text ?? '').match(new RegExp(`media[_ ]?id[^0-9a-f]{0,6}(${UUID.source})`, 'i'));
    return url && id ? { mediaId: id[1], uploadUrl: url[0].replace(/["',)]+$/, '') } : null;
}

/** The media id of a media_import_url / media_confirm answer. */
export function parseMediaId({ text, structured }) {
    for (const object of objects(structured)) {
        const id = object.media_id ?? object.id;
        if (typeof id === 'string' && UUID.test(id)) return id;
    }
    const { tables, values } = parseCompact(text);
    for (const rows of Object.values(tables)) for (const row of rows) if ((row.media_id ?? row.id) && UUID.test(row.media_id ?? row.id)) return row.media_id ?? row.id;
    if (values.media_id && UUID.test(values.media_id)) return values.media_id.match(UUID)[0];
    const match = String(text ?? '').match(new RegExp(`media[_ ]?id[^0-9a-f]{0,6}(${UUID.source})`, 'i')) ?? String(text ?? '').match(UUID);
    return match ? (match[1] ?? match[0]) : null;
}
