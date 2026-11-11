import { createHmac, timingSafeEqual } from 'node:crypto';

/** WhatsApp error codes. https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes */
export const OUTSIDE_WINDOW = 131047; // re-engagement: more than 24h since the person wrote
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

export class WhatsAppError extends Error {
    constructor(message, { code = null, status = null, retryable = false } = {}) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

export function verifySignature(appSecret, rawBody, header) {
    if (!header) return false;
    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const given = String(header).replace(/^sha256=/, '');
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createWhatsAppClient(config, fetchImpl = globalThis.fetch) {
    const url = `${config.graphUrl}/${config.graphVersion}/${config.phoneNumberId}/messages`;

    async function send(payload) {
        let response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
            });
        } catch (error) {
            throw new WhatsAppError(`network: ${error.message}`, { retryable: true });
        }
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            const code = json?.error?.code ?? null;
            const retryable = response.status >= 500 || response.status === 429 || RETRYABLE_CODES.has(code);
            throw new WhatsAppError(json?.error?.message ?? `HTTP ${response.status}`, {
                code,
                status: response.status,
                retryable,
            });
        }
        const id = json?.messages?.[0]?.id;
        if (!id) throw new WhatsAppError('WhatsApp accepted the request but returned no message id', { retryable: true });
        return id;
    }

    return { send };
}

/**
 * Builds the API payload for one of Echo's messages. Messages are stored in a
 * channel-neutral shape: { text, buttons?: [{ id, title }], replyTo? }.
 */
export function toPayload(to, message) {
    const context = message.replyTo ? { context: { message_id: message.replyTo } } : {};
    if (message.buttons?.length) {
        return {
            to,
            type: 'interactive',
            ...context,
            interactive: {
                type: 'button',
                body: { text: truncate(message.text, 1024) },
                action: {
                    buttons: message.buttons.slice(0, 3).map((button) => ({
                        type: 'reply',
                        reply: { id: button.id.slice(0, 256), title: truncate(button.title, 20) },
                    })),
                },
            },
        };
    }
    return { to, type: 'text', ...context, text: { body: truncate(message.text, 4096), preview_url: false } };
}

/** Template message; quick-reply buttons carry the same ids as the interactive buttons. */
export function toTemplatePayload(to, template, buttons = []) {
    const param = (text) => ({ type: 'text', text: truncate(String(text).replace(/\s+/g, ' ').trim() || '-', 900) });
    return {
        to,
        type: 'template',
        template: {
            name: template.name,
            language: { code: template.language ?? 'tr' },
            components: [
                ...(template.params?.length ? [{ type: 'body', parameters: template.params.map(param) }] : []),
                ...buttons.slice(0, 3).map((button, index) => ({
                    type: 'button',
                    sub_type: 'quick_reply',
                    index: String(index),
                    parameters: [{ type: 'payload', payload: button.id }],
                })),
            ],
        },
    };
}

/** Flattens a webhook body into messages and delivery statuses. */
export function parseWebhook(body) {
    const messages = [];
    const statuses = [];
    for (const entry of body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
            const value = change.value ?? {};
            for (const message of value.messages ?? []) {
                messages.push({
                    id: message.id,
                    from: message.from,
                    type: message.type,
                    text: message.text?.body ?? null,
                    buttonId: message.interactive?.button_reply?.id ?? message.button?.payload ?? null,
                    contextId: message.context?.id ?? null,
                    timestamp: Number(message.timestamp ?? 0) * 1000,
                });
            }
            for (const status of value.statuses ?? []) {
                statuses.push({
                    id: status.id,
                    status: status.status,
                    recipient: status.recipient_id,
                    error: status.errors?.[0] ? `${status.errors[0].code}: ${status.errors[0].title ?? status.errors[0].message ?? ''}` : null,
                });
            }
        }
    }
    return { messages, statuses };
}

const truncate = (text, length) => {
    const value = String(text ?? '');
    return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};
