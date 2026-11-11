import { loadConfig } from './config.js';
import { createEcho } from './core.js';
import { createStore, openDatabase } from './db.js';
import { createTryPostProject } from './projects/trypost.js';
import { createHttpServer } from './server.js';
import { createWhatsAppClient } from './whatsapp.js';

const log = (level, ...parts) => {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message: parts.join(' ') });
    (level === 'error' ? console.error : console.log)(line);
};

const config = loadConfig();
const store = createStore(openDatabase(config.dataDir));
const echo = createEcho({ config, store, whatsapp: createWhatsAppClient(config.whatsapp), log });

const projectTypes = { trypost: createTryPostProject };
for (const project of config.projects) {
    const factory = projectTypes[project.type];
    if (!factory) throw new Error(`Unknown project type ${project.type} for ${project.id}`);
    echo.register(project.id, factory(project, { timeZone: config.timeZone }));
}

const timer = setInterval(() => echo.tick().catch((error) => log('error', 'tick failed', error.message)), 15_000);
const server = createHttpServer({ config, echo, log });
server.listen(config.port, () => log('info', `Echo listening on :${config.port} with ${config.projects.length} project(s)`));

const stop = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
