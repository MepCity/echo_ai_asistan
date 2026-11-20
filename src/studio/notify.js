import { readFileSync } from 'node:fs';
import { OUTSIDE_WINDOW, isUserId, toPayload } from '../whatsapp.js';

const MB = 1024 * 1024;
// What WhatsApp takes as an image / audio message (webp images are stickers only, wav is not supported).
const WHATSAPP_IMAGE = { mimes: new Set(['image/jpeg', 'image/png']), max: 5 * MB };
const WHATSAPP_AUDIO = { mimes: new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg']), max: 16 * MB };

/**
 * Tells the person who asked for a generation that it finished, when it finished after Hermes had
 * already answered "still preparing" (the background check settled it). Sent by the studio itself
 * through the WhatsApp Cloud API with the same number (Echo's credentials from /opt/echo/.env), only
 * to a known person of config.json who may use the assistant. One attempt per generation: a failure
 * (e.g. outside the 24-hour window, code 131047) is logged and never retried; the result can still
 * be fetched with get_generation.
 *
 * deps: whatsapp ({ send(payload), uploadMedia({ bytes, mimeType, filename }) }), people (Echo's
 * normalized config.people), allowedPeople (person ids allowed to use the assistant, or null = any
 * known person), log.
 */
export function createStudioNotifier({ whatsapp, people, allowedPeople = null, log = () => {} }) {
    const byId = new Map(people.map((person) => [person.id, person]));

    /** { ok: true } or { ok: false, reason }. Never throws. */
    return async function notify({ requestedBy, text, file = null, mime = null }) {
        const person = byId.get(requestedBy);
        if (!person?.phone) return { ok: false, reason: 'unknown person' };
        if (allowedPeople && !allowedPeople.includes(person.id)) return { ok: false, reason: 'person may not use the assistant' };
        try {
            let media = null;
            let audio = null;
            if (file && mime) {
                const kind = WHATSAPP_IMAGE.mimes.has(mime) ? 'image' : WHATSAPP_AUDIO.mimes.has(mime) ? 'audio' : null;
                const bytes = kind ? readFileSync(file) : null;
                if (bytes && bytes.length <= (kind === 'image' ? WHATSAPP_IMAGE : WHATSAPP_AUDIO).max) {
                    const id = await whatsapp.uploadMedia({ bytes, mimeType: mime, filename: file.split('/').pop() });
                    if (kind === 'image') media = { type: 'image', id };
                    else audio = id;
                }
            }
            // An image carries the text as its caption; audio has no caption, so the text goes first.
            await whatsapp.send(toPayload(person.phone, { text }, media));
            if (audio) await whatsapp.send({ ...(isUserId(person.phone) ? { recipient: person.phone } : { to: person.phone }), type: 'audio', audio: { id: audio } });
            return { ok: true };
        } catch (error) {
            const reason = error.code === OUTSIDE_WINDOW ? 'outside the 24-hour window' : String(error.message ?? error).slice(0, 200);
            log('warn', 'studio ready notification failed (not retried)', requestedBy, reason);
            return { ok: false, reason };
        }
    };
}
