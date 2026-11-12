import { readFileSync } from 'node:fs';

/**
 * Echo's configuration is one JSON document: from the file named by
 * ECHO_CONFIG, or inline in ECHO_CONFIG_JSON. Any "${NAME}" inside a string is
 * replaced with that environment variable, so secrets stay in the environment
 * and the JSON can live in a repository or a secret manager.
 *
 * {
 *   "publicUrl": "https://echo.example.com",
 *   "whatsapp": { "phoneNumberId": "...", "accessToken": "${WA_ACCESS_TOKEN}",
 *                 "appSecret": "${WA_APP_SECRET}", "verifyToken": "${WA_VERIFY_TOKEN}" },
 *   "people": [ { "id": "yasir", "name": "Yasir", "phone": "905xxxxxxxxx" } ],
 *   "projects": [ { "id": "marmara", "type": "trypost", "name": "Marmara AI Sosyal",
 *                   "apiUrl": "https://sosyal.marmaraai.com/api", "publicUrl": "https://sosyal.marmaraai.com",
 *                   "apiToken": "${TRYPOST_API_TOKEN}", "webhookSecret": "${TRYPOST_WEBHOOK_SECRET}",
 *                   "templates": { "language": "tr", "approval": "onay_bekliyor", "feedback": "gorus_istegi" },
 *                   "members": [ { "person": "yasir", "userId": "<TryPost user id>", "roles": ["reviewer", "approver"] } ] } ],
 *   "assistant": { "url": "http://hermes:8090/whatsapp/webhook", "enabled": true }
 * }
 *
 * `assistant` (optional): where messages from known people that Echo does not
 * handle itself are forwarded, as signed WhatsApp webhooks (Hermes Agent's
 * WhatsApp Cloud adapter). Optional keys: "appSecret" (defaults to
 * whatsapp.appSecret) and "timeoutMs" (20000). Without it, or with
 * "enabled": false, Echo answers such messages with its help text.
 */
export function loadConfig(env = process.env) {
    const raw = env.ECHO_CONFIG_JSON ?? (env.ECHO_CONFIG ? readFileSync(env.ECHO_CONFIG, 'utf8') : null);
    if (!raw) throw new Error('Set ECHO_CONFIG (path to a JSON file) or ECHO_CONFIG_JSON');
    return normalizeConfig(interpolate(JSON.parse(raw), env));
}

function interpolate(value, env) {
    if (typeof value === 'string') {
        return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
            if (env[name] === undefined) throw new Error(`Config refers to missing environment variable ${name}`);
            return env[name];
        });
    }
    if (Array.isArray(value)) return value.map((item) => interpolate(item, env));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env)]));
    }
    return value;
}

export const normalizePhone = (phone) => String(phone ?? '').replace(/\D/g, '');

export function normalizeConfig(config) {
    const required = (object, keys, where) => {
        for (const key of keys) if (!object?.[key]) throw new Error(`Config: ${where}.${key} is required`);
    };

    required(config, ['whatsapp', 'people', 'projects'], 'root');
    required(config.whatsapp, ['phoneNumberId', 'accessToken', 'appSecret', 'verifyToken'], 'whatsapp');

    const people = config.people.map((person) => {
        required(person, ['id', 'name', 'phone'], `people[${person.id ?? '?'}]`);
        return { ...person, phone: normalizePhone(person.phone) };
    });
    const peopleById = new Map(people.map((person) => [person.id, person]));

    const projects = config.projects.map((project) => {
        required(project, ['id', 'type'], `projects[${project.id ?? '?'}]`);
        const members = (project.members ?? []).map((member) => {
            const person = peopleById.get(member.person);
            if (!person) throw new Error(`Config: project ${project.id} lists unknown person ${member.person}`);
            return { ...member, roles: member.roles ?? ['reviewer'], person };
        });
        return { name: project.id, templates: {}, ...project, members };
    });

    return {
        port: Number(config.port ?? process.env.PORT ?? 8080),
        dataDir: config.dataDir ?? process.env.DATA_DIR ?? './data',
        timeZone: config.timeZone ?? 'Europe/Istanbul',
        publicUrl: config.publicUrl ?? '',
        whatsapp: {
            graphUrl: 'https://graph.facebook.com',
            graphVersion: 'v23.0',
            ...config.whatsapp,
        },
        people,
        projects,
        assistant: normalizeAssistant(config.assistant, config.whatsapp),
    };
}

function normalizeAssistant(assistant, whatsapp) {
    if (!assistant || assistant.enabled === false || !assistant.url) return null;
    let url;
    try {
        url = new URL(assistant.url);
    } catch {
        throw new Error(`Config: assistant.url is not a URL (${assistant.url})`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Config: assistant.url must be http(s)');
    return {
        url: url.href,
        appSecret: assistant.appSecret ?? whatsapp.appSecret,
        timeoutMs: Number(assistant.timeoutMs ?? 20_000),
    };
}
