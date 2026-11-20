import { mkdirSync } from 'node:fs';
import { createRenderServer } from './server.js';

/**
 * The render service (deploy/oracle/render/Dockerfile): turns studio video jobs into MP4 with headless
 * Chromium + ffmpeg, and speech into subtitles with whisper.cpp. It has no secrets but its own bearer,
 * no internet route, a read-only root and a tmpfs work folder. Run: node src/render/index.js
 *
 * Env: ECHO_RENDER_TOKEN (required), RENDER_PORT (8092), RENDER_WORK_DIR (/tmp/render),
 * RENDER_TIMEOUT_SEC (300), RENDER_CHROME, RENDER_WHISPER_BIN, RENDER_WHISPER_MODEL.
 */
const log = (level, ...parts) => {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message: `render: ${parts.join(' ')}` });
    (level === 'error' ? console.error : console.log)(line);
};

const workRoot = process.env.RENDER_WORK_DIR ?? '/tmp/render';
mkdirSync(workRoot, { recursive: true });
const port = Number(process.env.RENDER_PORT ?? 8092);
const timeoutSec = Number(process.env.RENDER_TIMEOUT_SEC ?? 300);
const server = createRenderServer({ token: process.env.ECHO_RENDER_TOKEN, workRoot, timeoutSec, log });
server.listen(port, () => log('info', `listening on :${port}; job limit ${timeoutSec}s`));

const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
