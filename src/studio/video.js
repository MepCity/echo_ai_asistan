import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openAsBlob, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PLATFORM, LIMITS, PLATFORMS, RenderInputError, checkSeconds, outputSize, validateComposition, validateTemplate } from '../render/spec.js';
import { TEMPLATES } from '../render/templates.js';
import { UNKNOWN_PERSON, personBucket } from './config.js';
import { toPayload } from '../whatsapp.js';

/**
 * Video tools of the studio gateway (create_video, get_video, transcribe_audio), added to the gateway's
 * tools by withVideo(). Videos are drawn by the separate render service (src/render, its own container
 * with no secrets and no internet), never by Higgsfield (its video models stay blocked) and never by
 * Hermes: Hermes only picks a template and its texts, or writes a JSON scene description that is
 * checked here and again in the render service. No credits are spent; the limits are a daily count
 * and one render at a time.
 *
 * Assets are named by reference (the club logo, earlier generations gen_…, a picture the user sent):
 * the studio reads those files itself and sends their bytes with the job, under neutral ids (a0, a1…),
 * so the render service sees no paths and fetches nothing.
 *
 * Results are kept like images: the original MP4 in /data/studio/media, a WhatsApp copy under 16 MB
 * (re-encoded by the render service only when the original is larger) in the folder Hermes sends from,
 * and attach_to_trypost(vid_…) uploads the original to TryPost. A render that outlives the tool call is
 * pushed to the requester on WhatsApp when it finishes (same rules as late generations).
 *
 * config.json `studio.video` (every key optional):
 * { "dailyVideos": 10, "maxSeconds": 60, "shortSide": 1080, "fps": 25, "waitSec": 20,
 *   "renderTimeoutSec": 330, "previewMaxMb": 15, "msPerFrame": 120, "renderUrl": "http://render:8092" }
 * The bearer for the render service is ECHO_RENDER_TOKEN (env).
 */

const MB = 1024 * 1024;
const WHATSAPP_VIDEO_MAX = 16 * MB;
const NOTIFY_MAX_AGE_MS = 23 * 3_600_000;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const DEFAULT_LOGO_DIR = fileURLToPath(new URL('../../deploy/oracle/brand/', import.meta.url));

export const VIDEO_DEFAULTS = {
    dailyVideos: 10,
    maxSeconds: 60,
    shortSide: 1080,
    fps: 25,
    waitSec: 20,
    renderTimeoutSec: 330,
    previewMaxMb: 15,
    msPerFrame: 120,
};

class Refusal extends Error {
    constructor(message) {
        super(message);
        this.userMessage = message;
    }
}
const refuse = (message) => {
    throw new Refusal(message);
};

/** `raw` is config.json studio.video. */
export function normalizeVideo(raw, env = process.env) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const out = {};
    for (const [key, fallback] of Object.entries(VIDEO_DEFAULTS)) {
        const parsed = Number(value[key] ?? fallback);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Config: studio.video.${key} must be a number >= 0`);
        out[key] = parsed;
    }
    out.maxSeconds = Math.min(Math.max(out.maxSeconds, LIMITS.minSeconds), LIMITS.maxSeconds);
    if (![720, 1080].includes(out.shortSide)) throw new Error('Config: studio.video.shortSide must be 720 or 1080');
    if (!LIMITS.fps.includes(out.fps)) throw new Error(`Config: studio.video.fps must be one of ${LIMITS.fps.join(', ')}`);
    out.previewMaxMb = Math.min(out.previewMaxMb, 15.5);
    out.renderUrl = String(value.renderUrl ?? env.STUDIO_RENDER_URL ?? 'http://render:8092').replace(/\/+$/, '');
    out.token = env.ECHO_RENDER_TOKEN || null;
    return out;
}

/** videos.db next to studio.db. */
export function openVideoDatabase(dir) {
    let file = ':memory:';
    if (dir !== ':memory:') {
        mkdirSync(dir, { recursive: true });
        file = join(dir, 'videos.db');
    }
    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS videos (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            day TEXT NOT NULL,
            status TEXT NOT NULL,
            mode TEXT NOT NULL,
            template TEXT,
            platform TEXT NOT NULL,
            seconds REAL NOT NULL,
            duration REAL,
            width INTEGER,
            height INTEGER,
            fps INTEGER,
            frames INTEGER,
            render_ms INTEGER,
            captions INTEGER,
            requested_by TEXT,
            summary TEXT,
            file TEXT,
            bytes INTEGER,
            sha256 TEXT,
            preview_file TEXT,
            preview_bytes INTEGER,
            reason TEXT,
            notify_state TEXT
        );
        CREATE INDEX IF NOT EXISTS videos_day ON videos (day, status);
    `);
    return db;
}

function dayOf(ms, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * deps: settings (normalizeStudio), video (normalizeVideo), db (openVideoDatabase), store (the studio's
 * generations store, for gen_… assets), trypost ({ uploadMedia, request } | null), trypostVideoMb,
 * whatsapp ({ send, uploadMedia } | null), people, allowedPeople, fetchImpl, now, log.
 */
export function createVideoTools({ settings, video, db, store, trypost = null, trypostVideoMb = 100, whatsapp = null, people = [], allowedPeople = null, fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = () => {} }) {
    let inFlight = null; // { id, promise } of the render running now
    const peopleIds = people.map((person) => person.id);
    const byId = new Map(people.map((person) => [person.id, person]));
    const today = () => dayOf(now(), settings.timeZone);
    const newId = () => `vid_${now().toString(36)}${randomBytes(3).toString('hex')}`;
    const get = (id) => db.prepare('SELECT * FROM videos WHERE id = ?').get(String(id ?? '')) ?? null;
    function update(id, fields) {
        const keys = Object.keys(fields);
        db.prepare(`UPDATE videos SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => fields[key] ?? null), now(), id);
    }
    const dailyCount = () => db.prepare("SELECT COUNT(*) AS n FROM videos WHERE day = ? AND status != 'refused'").get(today()).n;
    const logoDir = settings.logoDir ?? process.env.STUDIO_LOGO_DIR ?? DEFAULT_LOGO_DIR;

    /** Learned speed (median ms per frame of the last renders), else the configured guess. */
    function msPerFrame() {
        const rows = db.prepare("SELECT render_ms * 1.0 / frames AS speed FROM videos WHERE status = 'completed' AND frames > 0 AND render_ms > 0 ORDER BY created_at DESC LIMIT 5").all();
        if (!rows.length) return video.msPerFrame;
        const speeds = rows.map((row) => row.speed).sort((a, b) => a - b);
        return speeds[Math.floor(speeds.length / 2)];
    }
    /** About how many minutes a render of `seconds` takes (frames, encoding, subtitles, transfer). */
    function estimateMinutes(seconds, { subtitles = false } = {}) {
        const ms = seconds * video.fps * msPerFrame() + 10_000 + (subtitles ? seconds * 600 : 0);
        return Math.max(1, Math.ceil(ms / 60_000));
    }

    // ---- assets ----------------------------------------------------------------------------------

    function pictureFile(value) {
        for (const dir of settings.referenceDirs ?? []) {
            const root = existsSync(resolve(dir)) ? realpathSync(resolve(dir)) : resolve(dir);
            let real;
            try {
                real = realpathSync(resolve(value));
            } catch {
                refuse('Görsel dosyasını bulamadım; kullanıcıdan görseli tekrar göndermesini iste.');
            }
            if (real.startsWith(root + sep)) return real;
        }
        refuse('Bu dosya videoda kullanılamaz; sadece üretimler (gen_…), kulüp logosu ya da kullanıcının WhatsApp’tan gönderdiği görseller kullanılabilir.');
    }

    /** Collects the files of one job: reference → neutral id, with bytes and mime. */
    function assetCollector() {
        const byRef = new Map();
        const assets = {};
        let total = 0;
        const add = (ref, key, file, mime) => {
            if (byRef.has(ref)) return byRef.get(ref);
            let bytes;
            try {
                bytes = readFileSync(file);
            } catch {
                refuse(`${ref} dosyası okunamadı.`);
            }
            if (bytes.length > LIMITS.assetBytes) refuse(`${ref} çok büyük (en fazla ${LIMITS.assetBytes / MB} MB).`);
            total += bytes.length;
            if (total > LIMITS.totalAssetBytes) refuse('Videodaki dosyaların toplamı çok büyük.');
            if (Object.keys(assets).length >= LIMITS.assets) refuse(`Bir videoda en fazla ${LIMITS.assets} dosya kullanılabilir.`);
            assets[key] = { mime, bytes };
            byRef.set(ref, key);
            return key;
        };
        let next = 0;
        /** The asset callback for spec.js: checks kind, returns the job id. */
        const asset = (ref, kind, field) => {
            const value = typeof ref === 'string' ? ref.trim() : '';
            if (!value) refuse(`${field}: dosya belirtilmemiş.`);
            if (value === 'logo' || value === 'logo-dark') {
                if (kind !== 'image') refuse(`${field}: ses olmalı.`);
                return add(value, value, join(logoDir, `${value}.png`), 'image/png');
            }
            if (/^gen_[a-z0-9]+$/i.test(value)) {
                const row = store.get(value);
                if (!row || row.status !== 'completed' || !row.file) refuse(`${field}: ${value} diye tamamlanmış bir üretim bulamadım.`);
                const rowKind = row.kind === 'image' ? 'image' : 'audio';
                if (rowKind !== kind) refuse(`${field}: ${value} bir ${rowKind === 'image' ? 'görsel' : 'ses'}; burada ${kind === 'image' ? 'görsel' : 'ses'} gerekiyor.`);
                const final = kind === 'image' && row.final_file && existsSync(row.final_file);
                return add(value, `a${next++}`, final ? row.final_file : row.file, final ? 'image/png' : row.mime);
            }
            if (value.startsWith('/')) {
                if (kind !== 'image') refuse(`${field}: ses için generate_audio ile üretilmiş bir gen_… kullan.`);
                const file = pictureFile(value);
                const mime = IMAGE_MIME[extname(file).slice(1).toLowerCase()];
                if (!mime) refuse(`${field}: PNG, JPEG ya da WebP görsel olmalı.`);
                return add(value, `a${next++}`, file, mime);
            }
            refuse(`${field}: "${value.slice(0, 40)}" kullanılamaz. Dosyalar gen_… (üretim), "logo", "logo-dark" ya da kullanıcının gönderdiği görselin yolu olmalı; internet adresi verilemez.`);
        };
        return { asset, assets, add };
    }

    // ---- job building -----------------------------------------------------------------------------

    function buildJob(args, id) {
        const platform = args.platform ?? DEFAULT_PLATFORM;
        if (!PLATFORMS[platform]) refuse(`platform şunlardan biri olmalı: ${Object.keys(PLATFORMS).join(', ')}.`);
        const seconds = checkSeconds(args.sure, video.maxSeconds);
        const hasTemplate = args.sablon !== undefined && args.sablon !== null;
        const hasComposition = args.kompozisyon !== undefined && args.kompozisyon !== null;
        if (hasTemplate === hasComposition) refuse('Ya "sablon" (ve parametreler) ya da "kompozisyon" ver; ikisi birden değil.');
        const collector = assetCollector();
        // The logo is always available to the renderer (templates use it), when the files exist.
        for (const variant of ['logo', 'logo-dark']) if (existsSync(join(logoDir, `${variant}.png`))) collector.add(variant, variant, join(logoDir, `${variant}.png`), 'image/png');
        const job = { id, size: { ...outputSize(platform, video.shortSide), fps: video.fps }, seconds };
        if (hasTemplate) {
            job.template = String(args.sablon);
            job.params = validateTemplate(job.template, args.parametreler, { asset: collector.asset });
        } else {
            if (args.parametreler !== undefined) refuse('parametreler sadece sablon ile verilir.');
            const checked = validateComposition(args.kompozisyon, { seconds, asset: collector.asset });
            job.composition = { ...(checked.background ? { background: checked.background } : {}), scenes: checked.scenes.map(({ start, ...scene }) => scene) };
        }
        const audio = {};
        if (args.muzik) audio.music = collector.asset(args.muzik, 'audio', 'muzik');
        if (args.seslendirme) audio.voiceover = collector.asset(args.seslendirme, 'audio', 'seslendirme');
        if (audio.voiceover) audio.subtitles = args.altyazi !== false;
        if (Object.keys(audio).length) job.audio = audio;
        return { job, assets: collector.assets, platform, seconds };
    }

    // ---- rendering --------------------------------------------------------------------------------

    async function callRender(path, { body, contentType, timeoutSec }) {
        let response;
        try {
            response = await fetchImpl(`${video.renderUrl}${path}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${video.token}`, 'Content-Type': contentType },
                body,
                signal: AbortSignal.timeout(timeoutSec * 1000),
            });
        } catch (error) {
            throw Object.assign(new Error(`render service unreachable: ${error.message}`), { userMessage: error.name === 'TimeoutError' ? 'Video servisi zamanında cevap vermedi; video durduruldu.' : 'Video servisine ulaşılamadı (render servisi çalışmıyor olabilir).' });
        }
        if (!response.ok) {
            let message = null;
            try {
                message = (await response.json())?.error ?? null;
            } catch {
                message = null;
            }
            throw Object.assign(new Error(`render ${path} ${response.status}`), { status: response.status, userMessage: typeof message === 'string' ? message.slice(0, 300) : 'Video oluşturulamadı.' });
        }
        return response;
    }

    /** Renders, stores the original and the WhatsApp copy, updates the row. Never throws. */
    async function renderAndStore(id, job, assets) {
        const started = now();
        try {
            const payload = JSON.stringify({ job, assets: Object.fromEntries(Object.entries(assets).map(([key, asset]) => [key, { mime: asset.mime, data: asset.bytes.toString('base64') }])) });
            const response = await callRender('/render', { body: payload, contentType: 'application/json', timeoutSec: video.renderTimeoutSec });
            const bytes = Buffer.from(await response.arrayBuffer());
            let info = {};
            try {
                info = JSON.parse(response.headers.get('x-render-info') ?? '{}');
            } catch {
                info = {};
            }
            if (bytes.length < 1000 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw Object.assign(new Error('render answer is not an MP4'), { userMessage: 'Video servisi geçerli bir dosya döndürmedi.' });
            mkdirSync(settings.originalsDir, { recursive: true });
            const file = join(settings.originalsDir, `${id}.mp4`);
            writeFileSync(file, bytes);
            let previewFile = file;
            let previewBytes = bytes.length;
            if (bytes.length > video.previewMaxMb * MB) {
                try {
                    const small = Buffer.from(await (await callRender(`/preview?max_mb=${video.previewMaxMb}`, { body: bytes, contentType: 'video/mp4', timeoutSec: video.renderTimeoutSec })).arrayBuffer());
                    if (small.length <= WHATSAPP_VIDEO_MAX) {
                        previewFile = join(settings.originalsDir, `${id}-preview.mp4`);
                        writeFileSync(previewFile, small);
                        previewBytes = small.length;
                    } else previewFile = null;
                } catch (error) {
                    log('warn', 'studio video preview failed', id, error.message);
                    previewFile = null;
                }
            }
            update(id, {
                status: 'completed',
                file,
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                preview_file: previewFile,
                preview_bytes: previewFile ? previewBytes : null,
                duration: Number(info.seconds) || job.seconds,
                frames: Number(info.frames) || null,
                render_ms: Number(info.ms) || now() - started,
                captions: Number(info.captions) || 0,
            });
            log('info', 'studio video rendered', id, `${(bytes.length / MB).toFixed(1)} MB`, `${now() - started} ms`);
        } catch (error) {
            update(id, { status: 'failed', reason: String(error.userMessage ?? 'Video oluşturulamadı.').slice(0, 300) });
            log('warn', 'studio video failed', id, String(error.message).slice(0, 300));
        }
        await notifyIfWaiting(id);
        return get(id);
    }

    // ---- results --------------------------------------------------------------------------------

    function exposeToHermes(file, name) {
        mkdirSync(settings.previewDir, { recursive: true });
        copyFileSync(file, join(settings.previewDir, name));
        return join(settings.hermesPreviewDir ?? settings.previewDir, name);
    }

    function describe(row) {
        const platform = PLATFORMS[row.platform];
        const lines = [`Video hazır. video_id: ${row.id}`, `${platform?.label ?? row.platform} (${row.width}x${row.height}), ${Math.round(row.duration ?? row.seconds)} sn${row.captions ? ', altyazılı' : ''}; kredi harcanmadı.`];
        if (row.preview_file && existsSync(row.preview_file)) {
            lines.push('Kullanıcıya göstermek için cevabına ayrı bir satırda aynen şunu yaz:', `MEDIA:${exposeToHermes(row.preview_file, `${row.id}-preview.mp4`)}`);
            if (row.preview_file !== row.file) lines.push('Bu WhatsApp için küçültülmüş kopya; asıl dosya sunucuda.');
        } else {
            lines.push('Video WhatsApp önizlemesi için fazla büyük; kullanıcı isterse get_video(orijinal: true) ile belge olarak gönder.');
        }
        lines.push(`Asıl MP4 sunucuda saklı (${((row.bytes ?? 0) / MB).toFixed(1)} MB). Gönderiye eklemek için attach_to_trypost(generation_id: "${row.id}") kullan.`);
        return lines.join('\n');
    }

    const readyText = (row) =>
        row.status === 'completed'
            ? `🎬 ${row.summary || 'Video'} hazır.\nGönderiye eklemek ya da değiştirmek için bana yazman yeterli.`
            : `❌ ${row.summary || 'Video'} oluşturulamadı: ${row.reason ?? ''}\nKendiliğimden tekrar denemiyorum.`;

    async function notifyIfWaiting(id) {
        const row = get(id);
        if (!row || row.notify_state !== 'waiting') return;
        update(id, { notify_state: 'sending' });
        const person = byId.get(row.requested_by);
        let state = 'skipped';
        if (whatsapp && person?.phone && (!allowedPeople || allowedPeople.includes(person.id)) && now() - row.created_at <= NOTIFY_MAX_AGE_MS) {
            try {
                let media = null;
                if (row.status === 'completed' && row.preview_file && (row.preview_bytes ?? 0) <= WHATSAPP_VIDEO_MAX) {
                    const mediaId = await whatsapp.uploadMedia({ bytes: readFileSync(row.preview_file), mimeType: 'video/mp4', filename: `${row.id}.mp4` });
                    media = { type: 'video', id: mediaId };
                }
                await whatsapp.send(toPayload(person.phone, { text: readyText(row) }, media));
                state = 'sent';
            } catch (error) {
                state = 'failed';
                log('warn', 'studio video notification failed (not retried)', id, String(error.message).slice(0, 200));
            }
        }
        update(id, { notify_state: state });
    }

    // ---- tool handlers ------------------------------------------------------------------------------

    function busyRow() {
        return db.prepare("SELECT * FROM videos WHERE status = 'rendering' ORDER BY created_at DESC LIMIT 1").get() ?? null;
    }

    async function createVideo(args) {
        if (!video.token) refuse('Video servisi henüz kurulmamış (render). Yöneticinin sunucuda update.sh çalıştırması gerekiyor.');
        if (inFlight || busyRow()) refuse('Şu an başka bir video hazırlanıyor; o bitince tekrar deneyebilirsin.');
        if (dailyCount() >= video.dailyVideos) refuse(`Bugünkü video sınırı doldu (${video.dailyVideos}). Yarın tekrar deneyebilirsin.`);
        const id = newId();
        let built;
        try {
            built = buildJob(args ?? {}, id);
        } catch (error) {
            if (error instanceof RenderInputError) refuse(error.userMessage);
            throw error;
        }
        const { job, assets, platform, seconds } = built;
        const time = now();
        db.prepare(
            `INSERT INTO videos (id, created_at, updated_at, day, status, mode, template, platform, seconds, width, height, fps, requested_by, summary)
             VALUES (?, ?, ?, ?, 'rendering', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, time, time, today(), job.template ? 'template' : 'composition', job.template ?? null, platform, seconds, job.size.width, job.size.height, job.size.fps, personBucket(args.requested_by, peopleIds), summaryOf(args.ozet));
        const minutes = estimateMinutes(seconds, { subtitles: job.audio?.subtitles });
        const promise = renderAndStore(id, job, assets).finally(() => {
            if (inFlight?.id === id) inFlight = null;
        });
        inFlight = { id, promise };
        const done = await Promise.race([promise, sleep(video.waitSec * 1000).then(() => null)]);
        if (done) return done.status === 'completed' ? describe(done) : `Video oluşturulamadı: ${done.reason}. Kendiliğimden tekrar denemiyorum.`;
        update(id, { notify_state: 'waiting' });
        // The render may have finished between the race and the update.
        const row = get(id);
        if (row.status !== 'rendering') {
            update(id, { notify_state: 'shown' });
            return row.status === 'completed' ? describe(row) : `Video oluşturulamadı: ${row.reason}.`;
        }
        return [
            `Video hazırlanıyor (video_id: ${id}). Yaklaşık ${minutes} dakika sürer; kredi harcamaz.`,
            `Kullanıcıya bunu söyle: video hazır olunca WhatsApp'tan kendiliğinden gelecek.${row.requested_by === UNKNOWN_PERSON ? ' (requested_by verilmediği için otomatik gönderilemeyecek; kullanıcı sorunca get_video ile al.)' : ''}`,
            'Bu sırada yeni video başlatma; kullanıcı sorarsa get_video ile durumuna bak.',
        ].join('\n');
    }

    async function getVideo({ video_id: id, orijinal }) {
        const row = get(id);
        if (!row) refuse('Bu video_id ile bir video bulamadım.');
        if (row.status === 'rendering') {
            const minutes = estimateMinutes(row.seconds);
            const elapsed = Math.floor((now() - row.created_at) / 60_000);
            return `Video hâlâ hazırlanıyor (${elapsed} dk geçti; toplam yaklaşık ${minutes} dk). Hazır olunca WhatsApp'tan gelecek.`;
        }
        if (row.status === 'failed') return `Video oluşturulamadı: ${row.reason ?? 'bilinmeyen hata'}. Kendiliğimden tekrar denemiyorum.`;
        if (row.notify_state === 'waiting') update(row.id, { notify_state: 'shown' });
        if (orijinal === true) {
            if (!row.file || !existsSync(row.file)) refuse('Asıl video dosyası bulunamadı.');
            return ['Asıl videoyu belge olarak göndermek için cevabına ayrı satırlarda aynen şunları yaz:', `MEDIA:${exposeToHermes(row.file, `${row.id}-original.mp4`)}`, '[[as_document]]', `(video/mp4, ${((row.bytes ?? 0) / MB).toFixed(1)} MB)`].join('\n');
        }
        return describe(row);
    }

    async function transcribeAudio({ generation_id: id }) {
        if (!video.token) refuse('Video servisi henüz kurulmamış (render).');
        const row = store.get(String(id ?? ''));
        if (!row || row.status !== 'completed' || !row.file || row.kind === 'image') refuse('Bu generation_id ile tamamlanmış bir ses bulamadım.');
        if (inFlight || busyRow()) refuse('Şu an bir video hazırlanıyor; o bitince tekrar deneyebilirsin.');
        let bytes;
        try {
            bytes = readFileSync(row.file);
        } catch {
            refuse('Ses dosyası okunamadı.');
        }
        if (bytes.length > LIMITS.assetBytes) refuse('Ses dosyası çok büyük.');
        const promise = callRender('/transcribe', { body: JSON.stringify({ audio: { mime: row.mime, data: bytes.toString('base64') }, language: 'tr' }), contentType: 'application/json', timeoutSec: video.renderTimeoutSec })
            .then((response) => response.json());
        inFlight = { id: `stt:${row.id}`, promise };
        let result;
        try {
            result = await promise;
        } catch (error) {
            refuse(error.userMessage ?? 'Ses yazıya dökülemedi.');
        } finally {
            if (inFlight?.id === `stt:${row.id}`) inFlight = null;
        }
        const segments = Array.isArray(result?.segments) ? result.segments.slice(0, 200) : [];
        if (!segments.length) return 'Seste anlaşılır bir konuşma bulamadım.';
        const stamp = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
        return [`Metin (whisper, otomatik; küçük hatalar olabilir): ${String(result.text ?? '').slice(0, 3000)}`, '', ...segments.map((segment) => `[${stamp(segment.start)}-${stamp(segment.end)}] ${String(segment.text).slice(0, 200)}`)].join('\n');
    }

    const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;
    async function attachVideo({ generation_id: id, post_id: postId, social_account_id: accountId, content }) {
        const row = get(id);
        if (!row) refuse('Bu video_id ile bir video bulamadım.');
        if (!trypost || !settings.project) refuse('Stüdyoya bağlı bir TryPost projesi yok; video eklenemiyor.');
        if (row.status !== 'completed' || !row.file || !existsSync(row.file)) refuse('Video henüz hazır değil.');
        const bytes = readFileSync(row.file);
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) refuse('Video dosyası değişmiş görünüyor; güvenlik için eklemiyorum.');
        if (bytes.length > trypostVideoMb * MB) refuse(`Video ${(bytes.length / MB).toFixed(1)} MB; TryPost en fazla ${trypostVideoMb} MB kabul ediyor.`);
        if (postId !== undefined && !SAFE_ID.test(String(postId))) refuse('Bu gönderiye erişemiyorum.');
        if (postId === undefined && (!accountId || !SAFE_ID.test(String(accountId)))) refuse('Yeni taslak için social_account_id gerekli (ya da post_id ver).');
        if (postId !== undefined) {
            try {
                await trypost.request('GET', `/posts/${postId}`);
            } catch (error) {
                if ([403, 404].includes(error.status)) refuse('Bu gönderiye erişemiyorum.');
                throw error;
            }
        }
        let upload;
        try {
            upload = await trypost.uploadMedia({ file: await openAsBlob(row.file, { type: 'video/mp4' }), filename: `${row.id}.mp4`, mimeType: 'video/mp4' });
        } catch (error) {
            if (error.status === 422) refuse(`TryPost videoyu kabul etmedi: ${String(error.message).replace(/^.*?:\s*/, '').slice(0, 160)}`);
            refuse('Videoyu TryPost’a yükleyemedim (bağlantı sorunu). Biraz sonra tekrar deneyebilirsin.');
        }
        let post;
        try {
            if (postId !== undefined) post = await trypost.request('POST', `/posts/${postId}/media/from-upload`, { upload_token: upload.uploadToken });
            else post = await trypost.request('POST', '/posts', { status: 'draft', social_account_id: accountId, content: content ?? '', media: [{ upload_token: upload.uploadToken }] });
        } catch (error) {
            if (error.status === 404 || error.status === 403) refuse('Bu gönderiye erişemiyorum.');
            if (error.status === 422) refuse(`TryPost kabul etmedi: ${String(error.body?.message ?? error.message).slice(0, 160)}`);
            refuse('Video yüklendi ama gönderiye eklenemedi; biraz sonra tekrar deneyebilirsin.');
        }
        const finalId = postId ?? (post?.data ?? post ?? {}).id ?? null;
        log('info', 'studio video attached to TryPost', row.id, String(finalId));
        return `Videonun asıl dosyası (video/mp4, ${(bytes.length / MB).toFixed(1)} MB) WhatsApp’tan geçmeden TryPost’a yüklendi ve ${postId !== undefined ? 'gönderiye eklendi' : `yeni taslak oluşturuldu (post_id: ${finalId})`}.`;
    }

    /** A 'rendering' row no render of this process is running for (the studio restarted mid-render) is marked failed. */
    async function checkPending() {
        const row = busyRow();
        if (row && inFlight?.id !== row.id) {
            update(row.id, { status: 'failed', reason: 'Video hazırlanırken stüdyo yeniden başladı.' });
            await notifyIfWaiting(row.id);
        }
    }

    // ---- schemas ----------------------------------------------------------------------------------

    const templateText = Object.entries(TEMPLATES)
        .map(([name, template]) => `${name} (${template.label}, varsayılan ${template.defaultSeconds} sn): ${Object.entries(template.params).map(([key, rule]) => `${key}${rule.required ? '*' : ''}`).join(', ')}`)
        .join('; ');
    const ozetProp = { type: 'string', maxLength: 200, description: 'Kullanıcıya gösterilecek tek satırlık Türkçe özet (ör. "Hackathon duyuru videosu"). Onay mesajında ve "hazır" bildiriminde görünür; her zaman doldur.' };
    const audioRef = (what) => ({ type: 'string', description: `${what}: generate_audio ile üretilmiş sesin generation_id’si (gen_…).` });

    const tools = [
        {
            name: 'create_video',
            description: [
                'Kısa video oluşturur (render servisi: hazır şablon ya da JSON sahne tarifi; Higgsfield kredisi HARCAMAZ). Onay ister.',
                `Sınırlar: günde ${video.dailyVideos} video, aynı anda bir video, ${LIMITS.minSeconds}-${video.maxSeconds} sn. Video birkaç dakika sürer; sonuç bitince WhatsApp'tan gelir.`,
                `Şablonlar (önerilen, güvenilir; * zorunlu): ${templateText}.`,
                'Dosyalar: "logo"/"logo-dark", önceki üretimler (gen_…; görsel ya da ses) ya da kullanıcının gönderdiği görselin yolu (/opt/data/cache/images/…). İnternet adresi verilemez.',
                'kompozisyon (sadece şablon uymuyorsa): {"background": Arka, "scenes": [{"duration": sn, "transition": "fade|slide-up|zoom|none", "background": Arka, "elements": [Öğe]}]}.',
                'Arka: {"color": "#0f1c47"} | {"gradient": ["#3278f6", "#3cbdfa"], "angle": 160} | {"image": "gen_…", "dim": 0-0.9, "kenburns": true}.',
                'Öğe (x, y, w, h: kare yüzdesi; size: 1080 kısa kenarda piksel): {"type": "text", "text", "x", "y", "w", "size", "weight": 400-900, "color", "align": "left|center|right", "font": "sans|serif", "background": "#rrggbb", "shadow", "uppercase", "animation", "delay"} | {"type": "image", "asset", "x", "y", "w", "h", "fit": "cover|contain", "shape": "rect|circle", "radius", "border", "kenburns"} | {"type": "shape", "shape": "rect|circle", "x", "y", "w", "h", "color"|"gradient", "radius", "opacity"} | {"type": "logo", "variant": "logo|logo-dark", "x", "y", "w"}.',
                'animation: none, fade, fade-up, fade-down, slide-left, slide-right, pop, zoom-in, wipe. Renkler sadece #rrggbb. Metinlerde adres/kod olamaz ("https://", "<", "url(" yok).',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    sablon: { type: 'string', enum: Object.keys(TEMPLATES), description: 'Hazır şablon. Ya sablon ya kompozisyon.' },
                    parametreler: { type: 'object', description: 'Şablonun parametreleri (yukarıdaki liste). Dosya parametreleri gen_…, "logo" ya da gönderilen görselin yolu.' },
                    kompozisyon: { type: 'object', description: 'Serbest sahne tarifi (JSON). Sadece hiçbir şablon uymuyorsa.' },
                    platform: { type: 'string', enum: Object.keys(PLATFORMS), description: `Hedef: ${Object.entries(PLATFORMS).map(([key, value]) => `${key} = ${value.label} ${value.ratio}`).join(', ')}. Varsayılan reels.` },
                    sure: { type: 'number', minimum: LIMITS.minSeconds, maximum: video.maxSeconds, description: 'Süre (saniye). Kısa tut: 10-20 sn idealdir. Seslendirme daha uzunsa video ona göre uzar.' },
                    muzik: audioRef('Arka plan müziği (isteğe bağlı)'),
                    seslendirme: audioRef('Seslendirme (isteğe bağlı)'),
                    altyazi: { type: 'boolean', description: 'Seslendirmeden otomatik Türkçe altyazı (whisper). Varsayılan: seslendirme varsa true.' },
                    requested_by: { type: 'string', description: `İsteyen kişinin Echo kişi anahtarı (ör. "yasir"); hazır bildirimi ona gider. Boş ya da bilinmeyen anahtar "${UNKNOWN_PERSON}".` },
                    ozet: ozetProp,
                },
                required: ['sure', 'ozet'],
                additionalProperties: false,
            },
            annotations: { title: 'Video oluştur (kredi harcamaz)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            handler: (args) => createVideo(args),
        },
        {
            name: 'get_video',
            description: 'create_video ile başlatılan videonun durumu; hazırsa önizleme (MEDIA satırı). orijinal: true asıl MP4’ü belge olarak verir. Kredi harcamaz.',
            inputSchema: {
                type: 'object',
                properties: {
                    video_id: { type: 'string', description: 'create_video sonucundaki video_id (vid_…).' },
                    orijinal: { type: 'boolean', description: 'true: asıl MP4’ü (sıkıştırılmamış) belge olarak gönder.' },
                },
                required: ['video_id'],
                additionalProperties: false,
            },
            annotations: { title: 'Video durumu', readOnlyHint: true, openWorldHint: false },
            handler: (args) => getVideo(args),
        },
        {
            name: 'transcribe_audio',
            description: 'Üretilmiş bir sesi (seslendirme, gen_…) zaman damgalı Türkçe metne çevirir (whisper, sunucuda). Altyazıyı kontrol etmek için; create_video seslendirme verilince altyazıyı zaten kendisi ekler. Kredi harcamaz.',
            inputSchema: {
                type: 'object',
                properties: { generation_id: { type: 'string', description: 'generate_audio sonucundaki generation_id (gen_…).' } },
                required: ['generation_id'],
                additionalProperties: false,
            },
            annotations: { title: 'Sesi yazıya dök', readOnlyHint: true, openWorldHint: false },
            handler: (args) => transcribeAudio(args),
        },
    ];

    return { tools, attachVideo, getVideo, checkPending, estimateMinutes, get, waitIdle: () => inFlight?.promise };
}

const summaryOf = (value) => {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text ? text.slice(0, 200) : null;
};

/**
 * The studio gateway with the video tools added: create_video / get_video / transcribe_audio, and
 * attach_to_trypost / get_original_file accepting a video_id (vid_…). Everything else goes to the
 * gateway unchanged.
 */
export function withVideo(gateway, videoTools) {
    const own = new Map(videoTools.tools.map((tool) => [tool.name, tool]));
    const run = async (fn) => {
        try {
            return { text: await fn(), isError: false };
        } catch (error) {
            if (error.userMessage) return { text: error.userMessage, isError: true };
            return { text: 'Stüdyoda beklenmeyen bir hata oldu; kendiliğimden tekrar denemiyorum. Biraz sonra tekrar deneyebilirsin.', isError: true };
        }
    };
    const isVideoId = (args) => typeof args?.generation_id === 'string' && args.generation_id.startsWith('vid_');
    return {
        ...gateway,
        tools: [...gateway.tools, ...videoTools.tools],
        async callTool(name, args = {}) {
            if (own.has(name)) return run(() => own.get(name).handler(args ?? {}));
            if (name === 'attach_to_trypost' && isVideoId(args)) return run(() => videoTools.attachVideo(args));
            if (name === 'get_original_file' && isVideoId(args)) return run(() => videoTools.getVideo({ video_id: args.generation_id, orijinal: true }));
            return gateway.callTool(name, args);
        },
        approvalHint(tool, args = {}) {
            if (tool === 'create_video') {
                const platform = PLATFORMS[args.platform] ? args.platform : DEFAULT_PLATFORM;
                return { aspect_ratio: PLATFORMS[platform].ratio, duration: Number(args.sure) || null, credits: 0 };
            }
            return gateway.approvalHint ? gateway.approvalHint(tool, args) : {};
        },
        async checkPending() {
            await gateway.checkPending?.();
            await videoTools.checkPending();
        },
    };
}

/** Wiring for src/studio/index.js. */
export function attachVideo(gateway, { config, settings, store, trypost, whatsapp, log }) {
    const video = normalizeVideo(config.studio?.video);
    const project = settings.project ? config.projects.find((item) => item.id === settings.project) : null;
    const tools = createVideoTools({
        settings,
        video,
        db: openVideoDatabase(settings.dataDir),
        store,
        trypost,
        trypostVideoMb: Number(project?.mediaLimitsMb?.video ?? 100),
        whatsapp,
        people: config.people,
        allowedPeople: config.assistant?.allowedPeople ?? null,
        log,
    });
    return withVideo(gateway, tools);
}
