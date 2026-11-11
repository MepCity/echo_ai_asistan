import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { parseWebhook, verifySignature } from './whatsapp.js';

const MAX_BODY = 1024 * 1024;

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('body too large'), { status: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

/** TryPost signs the JSON body with HMAC-SHA256 (hex) in X-Webhook-Signature. */
export function verifyProjectSignature(secret, rawBody, header) {
    if (!secret || !header) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    const given = Buffer.from(String(header).replace(/^sha256=/, ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}

export function createHttpServer({ config, echo, log = () => {} }) {
    const projects = new Map(config.projects.map((project) => [project.id, project]));

    const send = (response, status, body = '', type = 'text/plain') => {
        response.writeHead(status, { 'Content-Type': type });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const parseJson = (raw) => {
        try {
            return JSON.parse(raw.toString('utf8') || '{}');
        } catch {
            return undefined;
        }
    };
    // Work after the answer: the caller's timeout never waits on WhatsApp or a project API.
    const work = () => echo.tick().catch((error) => log('error', 'tick failed', error.message));

    async function handle(request, response) {
        const url = new URL(request.url, 'http://echo');
        const path = url.pathname.replace(/\/+$/, '') || '/';

        if (request.method === 'GET' && path === '/health') {
            return send(response, 200, { ok: true, outbox: echo.store.stats(), inbox: echo.store.inboxStats() }, 'application/json');
        }

        if (path === '/whatsapp' && request.method === 'GET') {
            const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === config.whatsapp.verifyToken;
            return ok ? send(response, 200, url.searchParams.get('hub.challenge') ?? '') : send(response, 403, 'forbidden');
        }

        if (path === '/whatsapp' && request.method === 'POST') {
            const raw = await readBody(request);
            if (!verifySignature(config.whatsapp.appSecret, raw, request.headers['x-hub-signature-256'])) {
                log('warn', 'WhatsApp webhook with a bad signature rejected');
                return send(response, 401, 'bad signature');
            }
            const body = parseJson(raw);
            if (body === undefined) return send(response, 400, 'bad json');
            // 200 only once everything is stored: if storing fails, a 500 makes Meta send the webhook again
            // (messages are keyed by id and statuses only move forward, so that is safe).
            try {
                echo.ingest(parseWebhook(body));
            } catch (error) {
                log('error', 'webhook could not be stored', error.message);
                return send(response, 500, 'error');
            }
            send(response, 200, 'ok');
            work();
            return;
        }

        const match = path.match(/^\/projects\/([\w-]+)\/webhook$/);
        if (match && request.method === 'POST') {
            const project = projects.get(match[1]);
            if (!project) return send(response, 404, 'unknown project');
            const raw = await readBody(request);
            if (!verifyProjectSignature(project.webhookSecret, raw, request.headers['x-webhook-signature'])) {
                log('warn', `project ${project.id} webhook with a bad signature rejected`);
                return send(response, 401, 'bad signature');
            }
            const event = parseJson(raw);
            if (event === undefined) return send(response, 400, 'bad json');
            if (event.type === 'webhook.test') return send(response, 200, 'ok');
            try {
                // Queues the messages in the outbox (durable) before the 200; they are delivered after it.
                await echo.acceptProjectEvent(project.id, event);
            } catch (error) {
                // A 5xx makes TryPost retry the webhook; dedupe keys keep that safe.
                log('error', `project ${project.id} event failed`, error.message);
                return send(response, 500, 'error');
            }
            send(response, 200, 'ok');
            work();
            return;
        }

        return send(response, 404, 'not found');
    }

    return createServer((request, response) => {
        handle(request, response).catch((error) => {
            log('error', 'request failed', error.message);
            if (!response.headersSent) send(response, error.status ?? 400, 'bad request');
        });
    });
}
