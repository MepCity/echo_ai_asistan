import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * A headless Chromium driven over the DevTools protocol on a pipe (--remote-debugging-pipe: fd 3 in,
 * fd 4 out, NUL-delimited JSON). No port is opened and no npm package (puppeteer) is needed.
 */

export function findChrome(env = process.env) {
    if (env.RENDER_CHROME) return env.RENDER_CHROME;
    for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/chrome']) {
        if (existsSync(candidate)) return candidate;
    }
    return 'chromium';
}

/**
 * Flags: the container is the sandbox (no network, no secrets, read-only, non-root, no caps), so
 * Chromium's own sandbox (it needs user namespaces Docker's seccomp profile blocks) is off. Everything
 * that phones home or spawns extra processes is off; one renderer process.
 */
export function chromeArgs(userDataDir) {
    return [
        '--headless',
        '--remote-debugging-pipe',
        `--user-data-dir=${userDataDir}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-domain-reliability',
        '--disable-sync',
        '--disable-client-side-phishing-detection',
        '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater,DialMediaRouteProvider,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,PaintHolding',
        '--metrics-recording-only',
        '--mute-audio',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--renderer-process-limit=1',
        '--js-flags=--max-old-space-size=256',
        '--proxy-server=127.0.0.1:9',
        '--proxy-bypass-list=<-loopback>',
        'about:blank',
    ];
}

/** Launches Chromium; returns { send(method, params, sessionId), on(event, fn), close(), process }. */
export function launchChrome({ executable = findChrome(), userDataDir, log = () => {} }) {
    const child = spawn(executable, chromeArgs(userDataDir), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const input = child.stdio[3];
    const output = child.stdio[4];
    let nextId = 1;
    const waiting = new Map();
    const listeners = new Map();
    let buffer = '';
    let stderr = '';
    let closed = false;

    child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    const failAll = (error) => {
        closed = true;
        for (const { reject } of waiting.values()) reject(error);
        waiting.clear();
    };
    child.on('exit', (code, signal) => failAll(new Error(`chromium exited (${signal ?? code}) ${stderr.trim().split('\n').slice(-3).join(' | ')}`)));
    child.on('error', (error) => failAll(error));
    input.on('error', () => {});
    output.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\0')) >= 0) {
            const text = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let message;
            try {
                message = JSON.parse(text);
            } catch {
                continue;
            }
            if (message.id !== undefined) {
                const pending = waiting.get(message.id);
                if (!pending) continue;
                waiting.delete(message.id);
                if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
                else pending.resolve(message.result ?? {});
            } else if (message.method) {
                for (const fn of listeners.get(message.method) ?? []) {
                    try {
                        fn(message.params ?? {}, message.sessionId);
                    } catch (error) {
                        log('warn', 'cdp listener failed', error.message);
                    }
                }
            }
        }
    });

    return {
        process: child,
        send(method, params = {}, sessionId = undefined) {
            if (closed) return Promise.reject(new Error('chromium is closed'));
            const id = nextId++;
            const message = { id, method, params };
            if (sessionId) message.sessionId = sessionId;
            return new Promise((resolve, reject) => {
                waiting.set(id, { resolve, reject, method });
                input.write(`${JSON.stringify(message)}\0`);
            });
        },
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
        },
        async close() {
            if (child.exitCode !== null || child.signalCode) return;
            try {
                await Promise.race([this.send('Browser.close'), new Promise((done) => setTimeout(done, 2000))]);
            } catch {
                // already gone
            }
            if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
        },
    };
}
