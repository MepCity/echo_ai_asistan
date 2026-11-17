import { loadConfig } from './config.js';
import { isUserId } from './whatsapp.js';

/**
 * Prints the phone numbers of the people who may use the assistant
 * (config.assistant.allowedPeople, see config.js), comma-separated, for
 * Hermes' WHATSAPP_CLOUD_ALLOWED_USERS. People known only by a BSUID are left
 * out (Hermes knows people by number). Prints nothing without an assistant.
 * Used by deploy/oracle/hermes/setup-hermes.sh inside the Echo container.
 */
const config = loadConfig();
const allowed = new Set(config.assistant?.allowedPeople ?? []);
const phones = config.people.filter((person) => allowed.has(person.id) && !isUserId(person.phone)).map((person) => person.phone);
process.stdout.write(phones.join(','));
