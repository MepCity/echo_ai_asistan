import { createHmac } from 'node:crypto';

/**
 * The conversational assistant behind Echo (Hermes Agent's WhatsApp Cloud
 * adapter). Echo stays the only webhook Meta calls; whatever Echo does not
 * handle itself is passed on as a WhatsApp webhook of its own, holding just
 * that message or status, signed with the app secret (X-Hub-Signature-256)
 * exactly as Meta would sign it, so the assistant's own signature check passes.
 *
 * forward() throws an error with `retryable = true` for network errors,
 * timeouts, 429 and 5xx (Echo keeps the item and tries again later), and a
 * plain error for any other refusal (bad signature, 4xx).
 */
export function createAssistant(config, { phoneNumberId, fetchImpl = globalThis.fetch }) {
    async function post(body) {
        const raw = JSON.stringify(body);
        const signature = createHmac('sha256', config.appSecret).update(raw).digest('hex');
        let response;
        try {
            response = await fetchImpl(config.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${signature}` },
                body: raw,
                signal: AbortSignal.timeout(config.timeoutMs),
            });
        } catch (error) {
            throw Object.assign(new Error(`assistant: ${error.message}`), { retryable: true });
        }
        await response.arrayBuffer().catch(() => null);
        if (response.ok) return;
        const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        throw Object.assign(new Error(`assistant: HTTP ${response.status}`), { retryable });
    }

    /** One stored inbound message (see parseWebhook), as the webhook Meta sent it. */
    function messageBody(message, person) {
        const contact = message.contact ?? { profile: { name: person?.name ?? '' }, wa_id: message.from };
        return envelope(message, { contacts: [contact], messages: [rawMessage(message)] });
    }

    /** One delivery status of a message the assistant sent. */
    function statusBody(status) {
        return envelope(status, { statuses: [status.raw ?? rawStatus(status)] });
    }

    function envelope(item, value) {
        const metadata = item.metadata ?? { display_phone_number: '', phone_number_id: String(phoneNumberId) };
        return {
            object: 'whatsapp_business_account',
            entry: [{ id: String(item.entryId ?? ''), changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata, ...value } }] }],
        };
    }

    return {
        forwardMessage: (message, person) => post(messageBody(message, person)),
        forwardStatus: (status) => post(statusBody(status)),
        messageBody,
        statusBody,
    };
}

/** The message as Meta sent it; rebuilt from the parsed fields for rows stored before Echo kept it. */
function rawMessage(message) {
    if (message.raw) return message.raw;
    const raw = {
        from: message.from,
        id: message.id,
        timestamp: String(Math.floor((message.timestamp || Date.now()) / 1000)),
        type: message.type ?? 'text',
    };
    if (message.contextId) raw.context = { from: message.from, id: message.contextId };
    if (message.buttonId) {
        raw.type = 'interactive';
        raw.interactive = { type: 'button_reply', button_reply: { id: message.buttonId, title: message.buttonId } };
    } else if (message.text !== null && message.text !== undefined) {
        raw.type = 'text';
        raw.text = { body: message.text };
    }
    return raw;
}

function rawStatus(status) {
    return { id: status.id, status: status.status, recipient_id: status.recipient, timestamp: String(Math.floor(Date.now() / 1000)) };
}
