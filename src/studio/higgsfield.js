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
        /**
         * Calls one allowed tool; returns { text, structured, meta, content, isError }: `text` joins the
         * text parts, `structured` is structuredContent, `meta` the result's _meta (widget state), and
         * `content` the raw content parts (kept for parsing and for the raw copy of odd answers).
         */
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
            return {
                text,
                structured: result?.structuredContent ?? null,
                meta: result?._meta ?? null,
                content: Array.isArray(result?.content) ? result.content : [],
                isError: Boolean(result?.isError),
            };
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

// A job id is a UUID: jobs_wait's schema takes nothing else (placeholders like "<first actual job ID>" never match).
const isUuid = (value) => typeof value === 'string' && new RegExp(`^${UUID.source}$`, 'i').test(value.trim());
const isJobToken = isUuid;
// Keys that name a job id outright, keys that hold a list of them.
const JOB_ID_KEYS = ['job_id', 'jobId', 'generation_id', 'generationId'];
const JOB_LIST_KEYS = ['job_ids', 'jobIds', 'generation_ids', 'generationIds'];
// A bare `id` counts only inside one of these (parent key) or next to one of these (sibling keys).
const JOB_PARENTS = new Set(['jobs', 'job', 'generations', 'generation', 'results', 'result', 'job_set', 'jobset', 'job_sets', 'items']);
const JOB_SIBLINGS = ['status', 'job_set_id', 'job_set_type', 'result_url', 'results'];

/** Parses a string that is a JSON object or array (whole, or the first {...}/[...] span in it); else undefined. */
function jsonIn(text) {
    const value = String(text ?? '').trim();
    if (!value) return undefined;
    const tries = [value];
    const object = value.indexOf('{');
    const array = value.indexOf('[');
    if (object >= 0) tries.push(value.slice(object, value.lastIndexOf('}') + 1));
    if (array >= 0) tries.push(value.slice(array, value.lastIndexOf(']') + 1));
    for (const candidate of tries) {
        if (!/^[[{]/.test(candidate)) continue;
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            // not JSON
        }
    }
    return undefined;
}

/** Collects job ids from a JSON value, depth-first in document order; JSON inside strings is walked too. */
function collectJobIds(value, parentKey, push, depth = 0) {
    if (depth > 40 || value === null || value === undefined) return;
    if (typeof value === 'string') {
        if (/^\s*[[{]/.test(value)) {
            const parsed = jsonIn(value);
            if (parsed !== undefined) collectJobIds(parsed, parentKey, push, depth + 1);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectJobIds(item, parentKey, push, depth + 1);
        return;
    }
    if (typeof value !== 'object') return;
    for (const key of JOB_ID_KEYS) if (isJobToken(value[key])) push(value[key]);
    for (const key of JOB_LIST_KEYS) {
        if (Array.isArray(value[key])) for (const item of value[key]) if (isJobToken(item)) push(item);
    }
    const parent = String(parentKey ?? '').toLowerCase();
    if (isJobToken(value.id) && (JOB_PARENTS.has(parent) || JOB_SIBLINGS.some((key) => key in value))) push(value.id);
    for (const [key, item] of Object.entries(value)) {
        if (item && (typeof item === 'object' || typeof item === 'string')) collectJobIds(item, key, push, depth + 1);
    }
}

/** The text parts of an answer (each content text part, else the joined text). */
function textParts(answer) {
    const parts = (answer.content ?? []).filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text);
    return parts.length ? parts : [String(answer.text ?? '')];
}

/**
 * The live generate_image answer (Nov 2026) is text:
 *   Submitted 1 job. If a widget is visible, it polls automatically — …
 *   - 8517fd80-1a96-419f-95a6-9312eb81e152  "prompt…"If the user requests …
 * i.e. "Submitted N job(s)" and one "- <uuid>" bullet per job. Returns those ids in order, or [].
 */
function submittedBullets(text) {
    if (!/\bSubmitted\s+\d+\s+jobs?\b/i.test(text)) return [];
    const ids = [];
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(new RegExp(`^\\s*[-*•]\\s+(${UUID.source})`, 'i'));
        if (match && !ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
}

/**
 * The job ids a generate_* answer names, in order, without duplicates. First the live format
 * ("Submitted N job(s)" + "- <uuid>" bullets, see submittedBullets); then, in order:
 * structuredContent, _meta, other content parts (resources), every JSON text part (all walked
 * recursively for job_id/jobId/generation_id, job_ids/jobIds lists, and `id` inside jobs/
 * generations/results/job_set/items or next to a `status`), compact tables whose header has
 * `job_id` or `id`, a "job_id: …" line, "job id … <uuid>" in the text, and last of all the one
 * UUID the text contains (only when it contains exactly one).
 */
export function parseJobIds(answer) {
    const { structured = null, meta = null } = answer ?? {};
    const ids = [];
    const push = (id) => {
        const value = String(id).trim();
        if (!ids.includes(value)) ids.push(value);
    };
    const texts = textParts(answer ?? {});
    const text = texts.join('\n');
    for (const id of submittedBullets(text)) push(id);
    collectJobIds(structured, null, push);
    collectJobIds(meta, null, push);
    for (const part of answer?.content ?? []) if (part && part.type !== 'text') collectJobIds(part, null, push);
    for (const part of texts) {
        const parsed = jsonIn(part);
        if (parsed !== undefined) collectJobIds(parsed, null, push);
    }
    const { tables, values } = parseCompact(text);
    for (const rows of Object.values(tables)) {
        for (const row of rows) {
            const id = 'job_id' in row ? row.job_id : row.id;
            if (isJobToken(id)) push(id);
        }
    }
    if (ids.length) return ids;
    if (isJobToken(values.job_id)) push(values.job_id);
    if (isJobToken(values.jobId)) push(values.jobId);
    if (ids.length) return ids;
    const match = text.match(new RegExp(`job[_ ]?id[^0-9a-f]{0,6}(${UUID.source})`, 'i'));
    if (match) return [match[1]];
    const uuids = [...new Set((text.match(new RegExp(UUID.source, 'gi')) ?? []).map((id) => id.toLowerCase()))];
    return uuids.length === 1 ? [text.match(UUID)[0]] : [];
}

const RAW_LIMIT = 8 * 1024;
const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value);

/** A raw copy of an answer (text parts, structuredContent, _meta, other content parts), at most ~8 KB. */
export function rawAnswer(answer) {
    const json = (value) => {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    };
    const others = (answer?.content ?? []).filter((part) => part?.type !== 'text');
    const sections = [
        ['content text', String(answer?.text ?? '')],
        ['structuredContent', answer?.structured == null ? '' : json(answer.structured)],
        ['_meta', answer?.meta == null ? '' : json(answer.meta)],
        ['other content', others.length ? json(others) : ''],
    ].filter(([, body]) => body);
    // Short sections keep everything; the longer ones share the rest of the room.
    const room = new Map();
    let budget = RAW_LIMIT - 64 * sections.length;
    let left = sections.length;
    for (const [name, body] of [...sections].sort((a, b) => a[1].length - b[1].length)) {
        const share = Math.max(0, Math.floor(budget / left--));
        room.set(name, Math.min(body.length, share));
        budget -= room.get(name);
    }
    const out = sections.map(([name, body]) => `--- ${name} ---\n${clip(body, room.get(name))}`);
    return clip(out.join('\n'), RAW_LIMIT) || '(empty answer)';
}

/** Text safe for a log line: no bearer/JWT/long tokens, no secret-looking values, no URL query strings. */
export function redactForLog(text) {
    return String(text ?? '')
        .replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, '$1?[query removed]')
        .replace(/\bBearer\s+[^\s"',]+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[token]')
        .replace(/(["']?[\w-]*(?:token|secret|password|passwd|api[_-]?key|signature|authorization|credential|cookie|session)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',&}\]]+/gi, '$1[redacted]')
        .replace(/\b(?=[A-Za-z0-9_\-+/]*\d)(?=[A-Za-z0-9_\-+/]*[A-Za-z])[A-Za-z0-9_\-+/]{40,}={0,2}/g, '[redacted]');
}

/** A short one-line, redacted excerpt of an answer for the log. */
export function answerExcerpt(answer, max = 300) {
    const raw = [answer?.text, answer?.structured == null ? '' : JSON.stringify(answer.structured), answer?.meta == null ? '' : JSON.stringify(answer.meta)]
        .filter(Boolean)
        .join(' | ');
    return clip(redactForLog(raw.replace(/\s+/g, ' ').trim()), max) || '(empty answer)';
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
