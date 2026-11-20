import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createTryPostProject } from '../projects/trypost.js';
import { createLogoCompositor } from './compose.js';
import { normalizeStudio } from './config.js';
import { createStudioGateway } from './gateway.js';
import { createStudioNotifier } from './notify.js';
import { createWhatsAppClient } from '../whatsapp.js';
import { createHiggsfieldClient } from './higgsfield.js';
import { createHiggsfieldAuth, createTokenFile } from './oauth.js';
import { createStudioServer } from './server.js';
import { createStudioStore, openStudioDatabase } from './store.js';
import { attachVideo } from './video.js';

/**
 * The studio gateway: an MCP server (http://studio:8091/mcp on the compose
 * network, never published) through which Hermes generates images and audio
 * with the club's Higgsfield account, within the limits of config.json
 * `studio` (see src/studio/config.js). Run: node src/studio/index.js
 * Higgsfield login once: node src/studio/login.js
 */
const log = (level, ...parts) => {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message: `studio: ${parts.join(' ')}` });
    (level === 'error' ? console.error : console.log)(line);
};

const config = loadConfig();
const settings = normalizeStudio(config.studio, config);
const store = createStudioStore(openStudioDatabase(settings.dataDir));
const auth = createHiggsfieldAuth({ file: createTokenFile(join(settings.dataDir, 'higgsfield-auth.json')), apiKey: process.env.HIGGSFIELD_API_KEY || null, log });
const higgsfield = createHiggsfieldClient({ url: settings.mcpUrl, auth });

let trypost = null;
if (settings.project) {
    const project = config.projects.find((item) => item.id === settings.project);
    const adapter = createTryPostProject(project, { timeZone: config.timeZone });
    trypost = { uploadMedia: adapter.uploadMedia, request: adapter.request, imageLimitMb: Number(project.mediaLimitsMb?.image ?? 10) };
}

// A generation that finishes after its call answered "still preparing" is pushed to the person who
// asked (config.json people[].phone), with Echo's own WhatsApp credentials; see notify.js.
const notify = createStudioNotifier({ whatsapp: createWhatsAppClient(config.whatsapp), people: config.people, allowedPeople: config.assistant?.allowedPeople ?? null, log });
// add_logo: the real logo PNG composited with ImageMagick (magick/convert via execFile, no shell).
const compositor = createLogoCompositor({ logoDir: settings.logoDir });
// Video tools (create_video, get_video, transcribe_audio) through the render service; see video.js.
const gateway = attachVideo(createStudioGateway({ settings, store, higgsfield, auth, trypost, log, notify, compositor }), { config, settings, store, trypost, whatsapp: createWhatsAppClient(config.whatsapp), log });
const server = createStudioServer({ gateway, token: process.env.ECHO_STUDIO_TOKEN, log });
// Jobs still running when their generate call answered "still preparing": finish them (or mark
// them 'unknown' past studio.pendingStaleMin) even if nobody asks with get_generation.
let checking = false;
const pendingTimer = setInterval(() => {
    if (checking) return;
    checking = true;
    gateway
        .checkPending()
        .catch((error) => log('warn', 'studio pending check failed', error.message))
        .finally(() => (checking = false));
}, 60_000);
pendingTimer.unref();
server.listen(settings.port, () => {
    const status = auth.status();
    log('info', `listening on :${settings.port}; Higgsfield ${status.connected ? `connected (${status.method})` : 'NOT connected (run src/studio/login.js)'}; TryPost project ${settings.project ?? 'none'}`);
});

const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
