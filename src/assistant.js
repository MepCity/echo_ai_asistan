import { createHmac } from 'node:crypto';
import { isUserId } from './whatsapp.js';

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
export function createAssistant(config, { phoneNumberId, fetchImpl = globalThis.fetch, trypostUserId = () => null }) {
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

    /**
     * One stored inbound message (see parseWebhook), as the webhook Meta sent it.
     * Hermes knows people only by phone number (`from`, `contacts[].wa_id`): when
     * Meta left it out (a user with a username, see whatsapp.js isUserId), Echo
     * puts in the number of the person it resolved the sender to. Hermes calls
     * the user by `contacts[].profile.name`, so for a known person Echo puts in
     * their address name from config (addressName) instead of their WhatsApp
     * profile name; an unknown sender keeps Meta's. A text, or the caption of
     * an image, video or document, of a person with a TryPost user id ends
     * with the user note (userNote).
     */
    function messageBody(message, person) {
        let raw = withUserNote(rawMessage(message), userNote(trypostUserId(person)));
        let contact = message.contact ?? { profile: { name: person?.name ?? '' }, wa_id: message.from };
        const name = addressName(person);
        if (name) contact = { ...contact, profile: { ...contact.profile, name } };
        const phone = person?.phone && !isUserId(person.phone) ? person.phone : null;
        if (phone && !raw.from) raw = { ...raw, from: phone };
        if (phone && !contact.wa_id) contact = { ...contact, wa_id: phone };
        return envelope(message, { contacts: [contact], messages: [raw] });
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

/**
 * What the assistant calls a person: `people[].hitap` when set, otherwise the
 * first word of `people[].name` ("Yasir Arslan" -> "Yasir"). Empty for no person.
 */
export function addressName(person) {
    const hitap = String(person?.hitap ?? '').trim();
    if (hitap) return hitap;
    return String(person?.name ?? '').trim().split(/\s+/)[0] ?? '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTED = new Set(['image', 'video', 'document']);

/**
 * The line that tells the assistant the sender's TryPost user id:
 * "[TryPost kullanıcı: <uuid>]". Null when the id is unknown or not a UUID
 * (an unset or unresolved config value), so nothing leaks then.
 */
export function userNote(userId) {
    const id = String(userId ?? '').trim();
    return UUID.test(id) ? `[TryPost kullanıcı: ${id.toLowerCase()}]` : null;
}

/**
 * The message with `note` as its own last line: after the text, or after the
 * caption (with its media note) of an image, video or document. Other types
 * (audio, buttons, locations, …) and slash commands are left as they are.
 * Never changes `raw`.
 */
export function withUserNote(raw, note) {
    if (!note) return raw;
    if (raw.type === 'text' && raw.text) {
        const body = String(raw.text.body ?? '');
        // A command ("/new", "/stop") stays as it was typed.
        if (body.trimStart().startsWith('/')) return raw;
        return { ...raw, text: { ...raw.text, body: body ? `${body}\n\n${note}` : note } };
    }
    if (NOTED.has(raw.type) && raw[raw.type]) {
        const block = raw[raw.type];
        const caption = String(block.caption ?? '');
        // Right below the media note "[TryPost medya: …]", else after a blank line.
        const afterMediaNote = caption.split('\n').at(-1).startsWith('[TryPost medya');
        const joined = !caption ? note : `${caption}${afterMediaNote ? '\n' : '\n\n'}${note}`;
        return { ...raw, [raw.type]: { ...block, caption: joined } };
    }
    return raw;
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
