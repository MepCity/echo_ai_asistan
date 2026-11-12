import { createHmac, timingSafeEqual } from 'node:crypto';

/** WhatsApp error codes. https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes */
export const OUTSIDE_WINDOW = 131047; // re-engagement: more than 24h since the person wrote
/** Meta could not fetch or process the media of a message (bad link, unreachable, unsupported, too large). */
export const MEDIA_ERROR_CODES = new Set([131052, 131053]);
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
    const base = `${config.graphUrl}/${config.graphVersion}/${config.phoneNumberId}`;

    async function call(path, init) {
        let response;
        try {
            response = await fetchImpl(`${base}/${path}`, {
                ...init,
                headers: { Authorization: `Bearer ${config.accessToken}`, ...(init.headers ?? {}) },
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
        return json;
    }

    async function send(payload) {
        const json = await call('messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        });
        const id = json?.messages?.[0]?.id;
        if (!id) throw new WhatsAppError('WhatsApp accepted the request but returned no message id', { retryable: true });
        return id;
    }

    /** Uploads a file to WhatsApp (POST /{phone-number-id}/media); returns its media id (valid for 30 days). */
    async function uploadMedia({ bytes, mimeType, filename = 'media' }) {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mimeType);
        form.append('file', new Blob([bytes], { type: mimeType }), filename);
        const json = await call('media', { method: 'POST', body: form });
        if (!json?.id) throw new WhatsAppError('WhatsApp accepted the upload but returned no media id', { retryable: true });
        return json.id;
    }

    return { send, uploadMedia };
}

/**
 * A WhatsApp business-scoped user id (BSUID): a two-letter country code, a
 * period and the id, e.g. "US.13491208655302741918" (a parent BSUID has "ENT."
 * after the country). Users with a WhatsApp username may reach us with only
 * this id: Meta then leaves out `messages[].from` and `contacts[].wa_id`.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
 */
export const isUserId = (address) => /^[A-Z]{2}\.[A-Z0-9.]+$/i.test(String(address ?? ''));

/** Who a message goes to: a phone number in `to`, a BSUID in `recipient` (Meta takes `to` when both are set). */
const addressee = (address) => (isUserId(address) ? { recipient: String(address) } : { to: address });

/** A resolved media: { type: 'image' | 'video', link } or { type, id } (an uploaded media id). */
const mediaObject = (media, extra = {}) => ({ ...(media.id ? { id: media.id } : { link: media.link }), ...extra });

/**
 * Builds the API payload for one of Echo's messages. Messages are stored in a
 * channel-neutral shape: { text, buttons?: [{ id, title }], cta?: { title, url }, replyTo? }.
 * `media` (resolved) becomes the header of an interactive message, or a plain
 * image/video message with the text as caption when there is nothing to tap.
 */
export function toPayload(to, message, media = null) {
    const context = message.replyTo ? { context: { message_id: message.replyTo } } : {};
    const header = media ? { header: { type: media.type, [media.type]: mediaObject(media) } } : {};
    if (message.buttons?.length) {
        return {
            ...addressee(to),
            type: 'interactive',
            ...context,
            interactive: {
                type: 'button',
                ...header,
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
    if (message.cta?.url) {
        return {
            ...addressee(to),
            type: 'interactive',
            ...context,
            interactive: {
                type: 'cta_url',
                ...header,
                body: { text: truncate(message.text, 1024) },
                action: { name: 'cta_url', parameters: { display_text: truncate(message.cta.title, 20), url: message.cta.url } },
            },
        };
    }
    if (media) {
        const caption = message.text ? { caption: truncate(message.text, 1024) } : {};
        return { ...addressee(to), type: media.type, ...context, [media.type]: mediaObject(media, caption) };
    }
    return { ...addressee(to), type: 'text', ...context, text: { body: truncate(message.text, 4096), preview_url: false } };
}

/**
 * Template message; quick-reply buttons carry the same ids as the interactive
 * buttons. `template.urlButton` ({ index, suffix }) fills a URL button's
 * dynamic part; `media` (resolved) fills an IMAGE/VIDEO header.
 */
export function toTemplatePayload(to, template, buttons = [], media = null) {
    const param = (text) => ({ type: 'text', text: truncate(String(text).replace(/\s+/g, ' ').trim() || '-', 900) });
    return {
        ...addressee(to),
        type: 'template',
        template: {
            name: template.name,
            language: { code: template.language ?? 'tr' },
            components: [
                ...(media ? [{ type: 'header', parameters: [{ type: media.type, [media.type]: mediaObject(media) }] }] : []),
                ...(template.params?.length ? [{ type: 'body', parameters: template.params.map(param) }] : []),
                ...buttons.slice(0, 3).map((button, index) => ({
                    type: 'button',
                    sub_type: 'quick_reply',
                    index: String(index),
                    parameters: [{ type: 'payload', payload: button.id }],
                })),
                ...(template.urlButton
                    ? [{
                          type: 'button',
                          sub_type: 'url',
                          index: String(template.urlButton.index ?? 0),
                          parameters: [{ type: 'text', text: template.urlButton.suffix }],
                      }]
                    : []),
            ],
        },
    };
}

/**
 * Flattens a webhook body into messages and delivery statuses. Each keeps what
 * Meta sent (`raw`, the sender's `contact`, the `metadata` and the entry id), so
 * Echo can pass it on to the assistant unchanged.
 */
export function parseWebhook(body) {
    const messages = [];
    const statuses = [];
    for (const entry of body?.entry ?? []) {
        for (const change of entry.changes ?? []) {
            const value = change.value ?? {};
            const origin = { metadata: value.metadata ?? null, entryId: entry.id ?? null };
            const contacts = value.contacts ?? [];
            for (const message of value.messages ?? []) {
                // A sender with a username may come without a phone number (`from`, `wa_id`), only with a BSUID.
                const contact =
                    contacts.find((item) => (message.from && item.wa_id === message.from) || (message.from_user_id && item.user_id === message.from_user_id)) ??
                    (contacts.length === 1 ? contacts[0] : null);
                messages.push({
                    id: message.id,
                    from: message.from ?? contact?.wa_id ?? null,
                    userId: message.from_user_id ?? contact?.user_id ?? null,
                    username: contact?.profile?.username ?? null,
                    type: message.type,
                    text: message.text?.body ?? null,
                    buttonId: message.interactive?.button_reply?.id ?? message.button?.payload ?? null,
                    contextId: message.context?.id ?? null,
                    timestamp: Number(message.timestamp ?? 0) * 1000,
                    raw: message,
                    contact,
                    ...origin,
                });
            }
            for (const status of value.statuses ?? []) {
                statuses.push({
                    id: status.id,
                    status: status.status,
                    recipient: status.recipient_id ?? null,
                    recipientUserId: status.recipient_user_id ?? null,
                    code: status.errors?.[0]?.code ?? null,
                    error: status.errors?.[0] ? `${status.errors[0].code}: ${status.errors[0].title ?? status.errors[0].message ?? ''}` : null,
                    raw: status,
                    ...origin,
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
