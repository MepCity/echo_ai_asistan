import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, MUSIC_MODEL, SPEECH_MODEL, UNKNOWN_PERSON, personBucket } from './config.js';
import { answerExcerpt, parseCredits, parseJob, parseJobIds, parseMediaId, parseUpload, rawAnswer } from './higgsfield.js';

/**
 * The studio gateway's tools: what Hermes may do with the club's Higgsfield
 * account, and nothing else. Hermes never sees Higgsfield's own tools or
 * credentials. Every generation goes through one path that checks, in order:
 * the request itself (allowlisted model, sizes), one generation at a time (no
 * other call in its submit window, and no earlier job still pending in the
 * database; one still running after pendingStaleMin becomes 'late' and stops
 * blocking), the cooldown, the daily counts, then Higgsfield's own cost
 * estimate against the per-request, daily, monthly and per-person credit caps. Only then is one
 * job sent (count/batch_size 1, never unlimited or free generations unless the
 * config allows), and it is never sent again: a lost answer is recorded as
 * 'unknown' and counts against the limits.
 *
 * Per-person caps are best-effort: `requested_by` comes from the model, and
 * Hermes cannot tell an MCP server who the WhatsApp sender of a call is (its
 * MCP client sends only the tool arguments; headers are fixed per connection).
 * A missing or unknown `requested_by` is charged to the shared 'bilinmiyor'
 * bucket with the same cap, so leaving it out never skips a cap, but a model
 * could still name someone else. The real guard is the global per-request,
 * daily and monthly caps.
 *
 * The finished file is kept exactly as Higgsfield made it (same bytes, format
 * and size; its sha256 is stored). WhatsApp gets a copy as a preview (it
 * recompresses images); TryPost gets the original bytes, server to server,
 * only through attach_to_trypost.
 */

const MB = 1024 * 1024;
const WHATSAPP_AUDIO_MAX = 16 * MB;
const TRYPOST_IMAGE_MB = 10;

const EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
};
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg' };
const REFERENCE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

export const MESSAGES = {
    busy: 'Şu an başka bir üretim sürüyor; o bitince tekrar deneyebilirsin.',
    pending: (id) => `Önceki üretim (generation_id: ${id}) hâlâ hazırlanıyor; o bitmeden yeni üretim başlatmıyorum. Birkaç dakika sonra get_generation ile sonucunu alıp tekrar deneyebilirsin.`,
    cooldown: (sec) => `Üretimler arasında kısa bir bekleme süresi var; yaklaşık ${sec} saniye sonra tekrar deneyebilirsin.`,
    dailyImages: 'Bugünkü görsel üretim sınırı doldu, yarın tekrar deneyebilirsin.',
    dailyMusic: 'Bugünkü müzik üretim sınırı doldu, yarın tekrar deneyebilirsin.',
    dailySpeech: 'Bugünkü seslendirme sınırı doldu, yarın tekrar deneyebilirsin.',
    dailyCredits: (left) => `Bugünkü kredi sınırı bu istek için yetmiyor (kalan yaklaşık ${left} kredi). Yarın tekrar deneyebilirsin.`,
    monthlyCredits: 'Bu ayki kredi sınırı doldu; yeni üretim için ay başını beklemek ya da yöneticinin sınırı artırması gerekiyor.',
    unknownPerson: (left) => `Kimin istediği belirtilmeyen üretimler için bugünkü ortak kredi sınırı doldu (kalan yaklaşık ${left} kredi). İsteyen kişiyi requested_by ile belirt ya da yarın tekrar dene.`,
    perPerson: (left) => `Bugün senin adına kullanılabilecek kredi sınırı doldu (kalan yaklaşık ${left} kredi). Yarın tekrar deneyebilirsin.`,
    tooExpensive: (cost, max) => `Bu istek yaklaşık ${cost} kredi tutuyor; tek seferde en fazla ${max} krediye izin var. Daha sade bir istekle (daha düşük çözünürlük ya da daha kısa süre) deneyebilirsin.`,
    noEstimate: 'Bu isteğin maliyetini doğrulayamadım, bu yüzden üretmedim. Biraz sonra tekrar deneyebilirsin.',
    video: 'Video üretimi henüz yok; şimdilik sadece görsel ve ses üretebiliyorum.',
    unknownModel: (list) => `Bu model kullanılamıyor. Kullanılabilen görsel modelleri: ${list}.`,
    unmatched: (id) =>
        `Bu üretimin sonucu eşleştirilemedi (generation_id: ${id}): Higgsfield isteği aldı ama cevabından iş numarasını okuyamadım, bu yüzden sonucu kendim getiremiyorum. Krediyi boşa harcamamak için tekrar göndermiyorum. Bir yönetici Higgsfield'deki işi bu üretime bağlayarak sonucu kurtarabilir; kullanıcıya bunu söyle.`,
    lostAnswer: "Higgsfield'den cevap alamadım; üretim yine de yapılmış olabilir. Krediyi boşa harcamamak için tekrar denemiyorum; birkaç dakika sonra studio_usage ile durumu kontrol edebilirsin.",
    notFound: 'Bu üretimi bulamadım.',
    notReady: 'Bu üretim henüz tamamlanmadı.',
    late: (id) => `Bu üretim (generation_id: ${id}) beklenenden uzun sürüyor; Higgsfield'de hâlâ çalışıyor. Hazır olunca get_generation ile alınabilir; tekrar göndermiyorum. Bu sırada yeni üretim başlatılabilir.`,
    audioAttach:
        "Ses dosyaları Instagram, LinkedIn ya da X gönderisine tek başına eklenemiyor. Dosya saklandı; ileride video servisi gelince videoda kullanılabilecek. Şimdilik WhatsApp'tan dinleyebilirsin.",
    noProject: 'TryPost bağlantısı ayarlı değil; görseli gönderiye eklemek için yöneticiye haber ver.',
    postScope: 'Bu gönderiyi Marmara AI çalışma alanında bulamadım; gönderi id’sini kontrol et.',
    needAccount: 'Yeni taslak için hangi hesaba (Instagram, LinkedIn, X…) hazırlanacağını bilmem gerekiyor; önce hesabı seç, sonra tekrar dene.',
    integrity: 'Saklanan dosya değişmiş görünüyor; güvenlik için yüklemiyorum. Yöneticiye haber ver.',
};

export class Refusal extends Error {
    constructor(message) {
        super(message);
        this.userMessage = message;
    }
}

const refuse = (message) => {
    throw new Refusal(message);
};

/** YYYY-MM-DD of a moment in a time zone. */
export function dayOf(ms, timeZone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

const round = (value) => Math.round(Number(value) * 100) / 100;

/** Width and height of a PNG, JPEG or WebP, or null (no decoding; just the header). */
export function imageSize(bytes) {
    try {
        if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
        if (bytes[0] === 0xff && bytes[1] === 0xd8) {
            let offset = 2;
            while (offset + 9 < bytes.length) {
                if (bytes[offset] !== 0xff) return null;
                const marker = bytes[offset + 1];
                const length = bytes.readUInt16BE(offset + 2);
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                    return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
                }
                offset += 2 + length;
            }
            return null;
        }
        if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
            const chunk = bytes.toString('ascii', 12, 16);
            if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
            if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
            if (chunk === 'VP8L') {
                const bits = bytes.readUInt32LE(21);
                return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
            }
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * deps: settings (normalizeStudio), store (createStudioStore), higgsfield ({ call }),
 * auth ({ status }), trypost ({ uploadMedia, request, projectName, imageLimitMb } | null),
 * fetchImpl (downloads, presigned uploads), sleep, log.
 */
export function createStudioGateway({ settings, store, higgsfield, auth = null, trypost = null, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = () => {} }) {
    // In-process lock for the submit window (estimate → send → job id). Jobs still running after
    // that are found in the database (status 'submitting' / 'submitted'), see settlePending.
    let inFlight = false;
    // Rows a jobs_wait check is running for, so two checks never store the same job twice.
    const settling = new Set();
    const staleMs = settings.pendingStaleMin * 60_000;
    const lateMs = settings.lateMaxHours * 3_600_000;
    const now = () => store.now();
    const today = () => dayOf(now(), settings.timeZone);
    const newId = () => `gen_${now().toString(36)}${randomBytes(3).toString('hex')}`;
    const limits = settings.limits;
    mkdirSync(settings.originalsDir, { recursive: true });

    function usageNumbers() {
        const day = today();
        const used = store.usage(day, day.slice(0, 7));
        const last = store.lastSentAt();
        const cooldownLeft = last ? Math.max(0, Math.ceil((last + limits.cooldownSec * 1000 - now()) / 1000)) : 0;
        return {
            day,
            ...used,
            remaining: {
                credits: round(Math.max(0, limits.dailyCredits - used.dayCredits)),
                monthCredits: round(Math.max(0, limits.monthlyCredits - used.monthCredits)),
                image: Math.max(0, limits.dailyImages - used.counts.image),
                music: Math.max(0, limits.dailyMusic - used.counts.music),
                speech: Math.max(0, limits.dailySpeech - used.counts.speech),
            },
            cooldownLeft,
        };
    }

    const remainingLine = (usage, kind) => {
        const left = usage.remaining;
        const what = kind === 'image' ? `${left.image} görsel` : kind === 'music' ? `${left.music} müzik` : `${left.speech} seslendirme`;
        return `Bugün kalan: yaklaşık ${left.credits} kredi, ${what}.${left.credits < 8 || left[kind] <= 2 ? ' (Sınır azaldı; kullanıcıya söyle.)' : ''}`;
    };

    /** Records a refused attempt and throws its message. */
    function refuseAttempt(attempt, message, estimated = null) {
        store.insert({ id: newId(), day: today(), month: today().slice(0, 7), tool: attempt.tool, kind: attempt.kind, model: attempt.model, params: attempt.params ? publicParams(attempt.params) : null, estimated, status: 'refused', reason: message, requestedBy: attempt.requestedBy });
        refuse(message);
    }

    /** What is stored of the params sent (prompts are kept: they are the club's own text). */
    const publicParams = (params) => ({ ...params, medias: params.medias?.map((media) => ({ role: media.role, value: media.value })) });

    // ---- references -------------------------------------------------------------------------

    async function uploadReferenceFile(path) {
        const ext = extname(path).slice(1).toLowerCase();
        if (!REFERENCE_EXT.has(ext)) refuse('Referans görsel PNG, JPEG ya da WebP olmalı.');
        const bytes = readFileSync(path);
        if (bytes.length > 10 * MB) refuse('Referans görsel çok büyük (10 MB sınırı).');
        const upload = parseUpload(await higgsfield.call('media_upload', { filename: basename(path), content_type: MIME_BY_EXT[ext] }));
        if (!upload) throw new Error('media_upload returned no upload URL');
        if (!upload.uploadUrl.startsWith('https://')) throw new Error('media_upload URL is not https');
        const put = await fetchImpl(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': MIME_BY_EXT[ext] }, body: bytes, signal: AbortSignal.timeout(120_000) });
        if (!put.ok) throw new Error(`reference upload: HTTP ${put.status}`);
        const confirmed = await higgsfield.call('media_confirm', { media_id: upload.mediaId, type: 'image' });
        if (confirmed.isError) throw new Error('media_confirm refused');
        return upload.mediaId;
    }

    async function importReferenceUrl(url) {
        const answer = await higgsfield.call('media_import_url', { url, type: 'image' });
        const id = answer.isError ? null : parseMediaId(answer);
        if (!id) refuse('Referans görseli Higgsfield’e aktaramadım (dosya türü desteklenmiyor olabilir). Referanssız deneyebilirsin.');
        return id;
    }

    /** A Higgsfield media id (or job id) for a reference the caller named. */
    async function resolveReference(reference) {
        const value = String(reference).trim();
        if (settings.logos[value]) return importReferenceUrl(settings.logos[value]);
        if (/^gen_[a-z0-9]+$/i.test(value)) {
            const row = store.get(value);
            if (!row || row.kind !== 'image' || row.status !== 'completed' || !row.job_id) refuse('Referans olarak verilen üretimi bulamadım.');
            return row.job_id;
        }
        if (value.startsWith('/')) {
            for (const dir of settings.referenceDirs) {
                const root = resolve(dir);
                let real;
                try {
                    real = realpathSync(resolve(value));
                } catch {
                    refuse('Referans görsel dosyasını bulamadım; kullanıcıdan görseli tekrar göndermesini iste.');
                }
                const rootReal = existsSync(root) ? realpathSync(root) : root;
                if (real.startsWith(rootReal + sep)) return uploadReferenceFile(real);
            }
            refuse('Bu dosya referans olarak kullanılamaz; sadece kullanıcının WhatsApp’tan gönderdiği görseller ya da kulüp logosu kullanılabilir.');
        }
        let url;
        try {
            url = new URL(value);
        } catch {
            refuse('Referans görseli anlayamadım. "logo", "logo-dark", bir üretim id’si (gen_…) ya da kullanıcının gönderdiği görselin yolu olmalı.');
        }
        if (url.protocol !== 'https:' || !settings.referenceHosts.includes(url.hostname)) refuse('Bu adresteki görsel referans olarak kullanılamaz; sadece kulübün kendi sitesindeki görseller kabul ediliyor.');
        return importReferenceUrl(url.href);
    }

    // ---- results ----------------------------------------------------------------------------

    async function download(url, id) {
        if (!String(url).startsWith('https://')) throw new Error('result URL is not https');
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok || !response.body) throw new Error(`result download: HTTP ${response.status}`);
        const limit = settings.maxDownloadMb * MB;
        if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('result too large');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit) throw new Error('result too large');
            chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const urlExt = extname(new URL(url).pathname).slice(1).toLowerCase();
        const headerMime = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const mime = EXTENSIONS[headerMime] ? headerMime : MIME_BY_EXT[urlExt] ?? (headerMime || 'application/octet-stream');
        const ext = EXTENSIONS[mime] ?? (urlExt || 'bin');
        const file = join(settings.originalsDir, `${id}.${ext}`);
        const tmp = `${file}.tmp`;
        // The bytes as Higgsfield sent them: never decoded or re-encoded.
        writeFileSync(tmp, bytes, { mode: 0o644 });
        renameSync(tmp, file);
        return { file, mime, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), size: mime.startsWith('image/') ? imageSize(bytes) : null };
    }

    /** A copy of a stored file in the directory Hermes delivers from; returns its path as Hermes sees it. */
    function exposeToHermes(row, suffix = '') {
        mkdirSync(settings.previewDir, { recursive: true });
        const name = `${row.id}${suffix}${extname(row.file)}`;
        copyFileSync(row.file, join(settings.previewDir, name));
        return join(settings.hermesPreviewDir, name);
    }

    function describeResult(row, usage, extra = []) {
        const lines = [`Üretim tamamlandı. generation_id: ${row.id}`];
        const params = row.params ? JSON.parse(row.params) : {};
        const credits = row.actual_credits ?? row.estimated_credits;
        lines.push(`Model: ${row.model}${params.aspect_ratio ? `, oran: ${params.aspect_ratio}` : ''}. Kredi: yaklaşık ${round(credits ?? 0)}.`);
        const meta = [row.mime, row.width ? `${row.width}x${row.height}` : null, `${(row.bytes / MB).toFixed(1)} MB`].filter(Boolean).join(', ');
        if (row.kind === 'image') {
            if (row.bytes <= settings.whatsappPreviewMaxMb * MB) {
                lines.push('Kullanıcıya önizlemeyi göstermek için cevabına ayrı bir satırda aynen şunu yaz:', `MEDIA:${exposeToHermes(row, '-preview')}`);
                lines.push('WhatsApp görseli sıkıştırır; bu sadece önizleme.');
            } else {
                lines.push('Dosya WhatsApp önizlemesi için fazla büyük; kullanıcı görmek isterse get_original_file ile belge olarak gönder.');
            }
            lines.push(`Asıl dosya sunucuda değiştirilmeden saklı (${meta}). Gönderiye eklemek için attach_to_trypost kullan (WhatsApp'tan geçmez, kalite kaybı olmaz). Kullanıcı asıl dosyayı isterse get_original_file.`);
        } else {
            if (row.bytes <= WHATSAPP_AUDIO_MAX) {
                lines.push('Kullanıcıya dinletmek için cevabına ayrı bir satırda aynen şunu yaz:', `MEDIA:${exposeToHermes(row)}`);
            }
            lines.push(`Ses dosyası saklandı (${meta}); sosyal medya gönderisine tek başına eklenemez, ileride videoda kullanılabilir.`);
        }
        lines.push(...extra, remainingLine(usage, row.kind));
        return lines.join('\n');
    }

    /** Waits for a job (polling jobs_wait), then stores its file. Returns the final row. */
    async function finish(id, jobId, deadline) {
        if (settling.has(id)) return store.get(id);
        settling.add(id);
        try {
            return await finishOnce(id, jobId, deadline);
        } finally {
            settling.delete(id);
        }
    }

    async function finishOnce(id, jobId, deadline) {
        let job = { status: 'unknown', terminal: false };
        do {
            try {
                job = parseJob(await higgsfield.call('jobs_wait', { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: settings.waitSliceSec }), jobId);
            } catch (error) {
                log('warn', 'studio jobs_wait failed', id, error.message);
            }
            if (job.terminal || now() >= deadline) break;
            // jobs_wait already waited waitSliceSec; a short pause keeps a fast-failing call from spinning.
            await sleep(settings.waitSliceSec === 0 ? 2000 : 250);
        } while (now() < deadline);

        if (job.status === 'completed' && job.url) {
            const stored = await download(job.url, id);
            store.update(id, { status: 'completed', file: stored.file, mime: stored.mime, bytes: stored.bytes, sha256: stored.sha256, sourceUrl: job.url, width: stored.size?.width, height: stored.size?.height });
            log('info', 'studio generation completed', id, stored.mime, String(stored.bytes));
        } else if (job.terminal) {
            store.update(id, { status: 'failed', reason: String(job.error ?? job.status).slice(0, 300) });
            log('warn', 'studio generation failed', id, job.status);
        }
        return store.get(id);
    }

    /** One jobs_wait look at a row's job (a finished one becomes completed/failed); errors are logged, not thrown. */
    async function lookOnce(row) {
        if (settling.has(row.id)) return;
        try {
            await finish(row.id, row.job_id, now());
        } catch (error) {
            log('warn', 'studio pending check failed', row.id, error.message);
        }
    }

    /**
     * Brings one sent-but-unfinished row up to date.
     * - pending ('submitting'/'submitted') under the stale limit: one look when `check`.
     * - pending past pendingStaleMin: without a job id it becomes 'unknown'; with one, a last look,
     *   and if the job is still running it becomes 'late' (no longer blocks, still counted, keeps its job id).
     * - 'late': polled (when `check`) until it finishes; past lateMaxHours it becomes 'unknown'.
     */
    async function settleRow(row, { check = true } = {}) {
        // A row an admin recovered (studio.sh recover) is timed from the recovery, not from when it was sent.
        const age = now() - (row.recovered_at ?? row.created_at);
        if (row.status === 'late') {
            if (age >= lateMs) {
                store.update(row.id, { status: 'unknown', reason: `late over ${settings.lateMaxHours} h` });
                log('warn', 'studio late generation given up, marked unknown', row.id);
            } else if (check && row.job_id) {
                await lookOnce(row);
            }
            return;
        }
        if (age >= staleMs) {
            if (!row.job_id) {
                store.update(row.id, { status: 'unknown', reason: `pending over ${settings.pendingStaleMin} min without a job id (last status ${row.status})` });
                log('warn', 'studio generation stale without job id, marked unknown', row.id, row.status);
                return;
            }
            if (settling.has(row.id)) return;
            await lookOnce(row);
            const after = store.get(row.id);
            if (after.status === 'submitted' || after.status === 'submitting') {
                store.update(row.id, { status: 'late', reason: `still running after ${settings.pendingStaleMin} min` });
                log('warn', 'studio generation late', row.id);
            }
            return;
        }
        if (check && row.status === 'submitted' && row.job_id) await lookOnce(row);
    }

    /** Settles pending rows (and, with `late`, polls late ones); returns the rows still pending (blocking). */
    async function settlePending({ check = true, late = false } = {}) {
        for (const row of store.pending()) await settleRow(row, { check });
        if (late) for (const row of store.late()) await settleRow(row, { check });
        return store.pending();
    }

    function failedMessage(row) {
        const why = row.reason ?? '';
        if (/nsfw|ip_detected/i.test(why)) return 'Higgsfield bu içeriği güvenlik/telif kuralları nedeniyle üretmedi. İsteği değiştirerek tekrar deneyebilirsin.';
        return `Üretim başarısız oldu${why ? ` (${why.slice(0, 120)})` : ''}. Kendiliğimden tekrar denemiyorum; istersen isteği değiştirip yeniden başlatabilirsin.`;
    }

    /** The one path every generation takes. */
    async function generate(attempt) {
        const { kind, requestedBy } = attempt;
        if (inFlight) refuseAttempt(attempt, MESSAGES.busy);
        inFlight = true;
        try {
            // A job sent earlier may still be running (the call that sent it answered "still preparing").
            const [pending] = await settlePending();
            if (pending) refuseAttempt(attempt, MESSAGES.pending(pending.id));
            const before = usageNumbers();
            if (before.cooldownLeft > 0) refuseAttempt(attempt, MESSAGES.cooldown(before.cooldownLeft));
            const dailyCount = { image: [limits.dailyImages, MESSAGES.dailyImages], music: [limits.dailyMusic, MESSAGES.dailyMusic], speech: [limits.dailySpeech, MESSAGES.dailySpeech] }[kind];
            if (before.counts[kind] >= dailyCount[0]) refuseAttempt(attempt, dailyCount[1]);
            if (before.monthCredits >= limits.monthlyCredits) refuseAttempt(attempt, MESSAGES.monthlyCredits);

            const params = { ...attempt.params };
            if (attempt.reference) params.medias = [{ value: await resolveReference(attempt.reference), role: 'image_references' }];
            const estimateTool = kind === 'image' ? 'estimate_image_cost' : 'estimate_audio_cost';
            let estimate = null;
            try {
                const answer = await higgsfield.call(estimateTool, { params });
                estimate = answer.isError ? null : parseCredits(answer);
            } catch (error) {
                if (error.notConnected) throw error;
                log('warn', 'studio estimate failed', error.message);
            }
            if (estimate === null || !Number.isFinite(estimate)) refuseAttempt({ ...attempt, params }, MESSAGES.noEstimate);
            const cost = round(estimate);
            if (cost > limits.maxCreditsPerRequest) refuseAttempt({ ...attempt, params }, MESSAGES.tooExpensive(cost, limits.maxCreditsPerRequest), cost);
            const usage = usageNumbers();
            if (usage.dayCredits + cost > limits.dailyCredits) refuseAttempt({ ...attempt, params }, MESSAGES.dailyCredits(usage.remaining.credits), cost);
            if (usage.monthCredits + cost > limits.monthlyCredits) refuseAttempt({ ...attempt, params }, MESSAGES.monthlyCredits, cost);
            // Best-effort (requested_by is the model's word); a missing or unknown one shares the 'bilinmiyor' cap.
            const spent = store.personCredits(usage.day, requestedBy);
            if (spent + cost > limits.perPersonDailyCredits) {
                const left = round(Math.max(0, limits.perPersonDailyCredits - spent));
                refuseAttempt({ ...attempt, params }, requestedBy === UNKNOWN_PERSON ? MESSAGES.unknownPerson(left) : MESSAGES.perPerson(left), cost);
            }

            const id = newId();
            store.insert({ id, day: usage.day, month: usage.day.slice(0, 7), tool: attempt.tool, kind, model: params.model, params: publicParams(params), estimated: cost, status: 'submitting', requestedBy });
            const deadline = now() + settings.jobTimeoutSec * 1000;
            let answer;
            try {
                answer = await higgsfield.call(attempt.tool, { params, context: 'Kulüp sosyal medya içeriği için tek üretim.' });
            } catch (error) {
                // Sent, but no answer: it may have run. Counted, never sent again.
                store.update(id, { status: 'unknown', reason: String(error.message).slice(0, 300) });
                log('warn', 'studio generation answer lost', id, error.message);
                refuse(MESSAGES.lostAnswer);
            }
            if (answer.isError) {
                store.update(id, { status: 'failed', reason: answer.text.slice(0, 300) });
                refuse(`Higgsfield bu isteği kabul etmedi: ${answer.text.replace(/\s+/g, ' ').slice(0, 160)}`);
            }
            const [jobId] = parseJobIds(answer);
            const actual = /charged|spent|harcan/i.test(answer.text) ? parseCredits(answer) : null;
            if (!jobId) {
                // Higgsfield took it (and likely charged it) but no job id could be read: keep the raw
                // answer so an admin can find the job and attach it (studio.sh raw / recover).
                store.update(id, { status: 'unknown', reason: 'no job id in answer', rawAnswer: rawAnswer(answer), ...(actual !== null ? { actual } : {}) });
                log('warn', 'studio generation answer has no job id, raw answer stored', id, attempt.tool, `excerpt: ${answerExcerpt(answer)}`);
                refuse(MESSAGES.lostAnswer);
            }
            store.update(id, { status: 'submitted', jobId, ...(actual !== null ? { actual } : {}) });
            log('info', 'studio generation submitted', id, attempt.tool, params.model, `est=${cost}`);

            const row = (await finish(id, jobId, deadline));
            if (row.status === 'completed') return describeResult(row, usageNumbers());
            if (row.status === 'failed') refuse(failedMessage(row));
            return `Üretim hâlâ hazırlanıyor (generation_id: ${row.id}). Kullanıcıya biraz sürdüğünü söyle; birkaç dakika sonra get_generation ile sonucu al. Yeni bir üretim başlatma.`;
        } finally {
            inFlight = false;
        }
    }

    // ---- tools ------------------------------------------------------------------------------

    const voiceKeys = Object.keys(settings.voices);
    const aspectRatios = [...new Set(settings.imageModels.flatMap((model) => IMAGE_MODELS[model].aspectRatios))];
    const platformKeys = Object.keys(settings.platformAspectRatios);
    const requestedByProp = {
        type: 'string',
        description: `İsteyen kişinin Echo kişi anahtarı (ör. "yasir"). Sadece kayıt ve kişi başı sınır için; kimlik doğrulaması değildir. Boş ya da bilinmeyen anahtar ortak "${UNKNOWN_PERSON}" sınırından düşer.`,
    };
    const generationIdProp = { type: 'string', description: 'generate_image / generate_audio sonucundaki generation_id (gen_…).' };

    const tools = [
        {
            name: 'get_brand_kit',
            description: 'Marmara Yapay Zeka Kulübü marka kiti: renkler, logo, ton, görsel kurallar, şablonlar ve platform oranları. Görsel ya da ses üretmeden önce mutlaka oku.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { title: 'Marka kiti', readOnlyHint: true, openWorldHint: false },
            handler: () => brandKit(),
        },
        {
            name: 'studio_usage',
            description: 'Bugünkü üretim kullanımı, kalan kredi ve adet sınırları, bekleme süresi ve devam eden üretim. Kredi harcamaz.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { title: 'Stüdyo kullanımı', readOnlyHint: true, openWorldHint: false },
            handler: () => usageText(),
        },
        {
            name: 'get_generation',
            description: 'Daha önce başlatılmış bir üretimin durumu; hazırsa önizleme satırını verir. Kredi harcamaz, yeni üretim başlatmaz.',
            inputSchema: { type: 'object', properties: { generation_id: generationIdProp }, required: ['generation_id'], additionalProperties: false },
            annotations: { title: 'Üretim durumu', readOnlyHint: true, openWorldHint: false },
            handler: (args) => getGeneration(args),
        },
        {
            name: 'get_original_file',
            description: "Üretilen dosyanın asıl halini (sıkıştırılmamış) WhatsApp'ta belge olarak göndermek için yolunu verir. Kredi harcamaz.",
            inputSchema: { type: 'object', properties: { generation_id: generationIdProp }, required: ['generation_id'], additionalProperties: false },
            annotations: { title: 'Asıl dosya', readOnlyHint: true, openWorldHint: false },
            handler: (args) => originalFile(args),
        },
        {
            name: 'generate_image',
            description:
                'Kulübün Higgsfield hesabıyla TEK bir görsel üretir; kredi harcar (genelde 2-8 kredi). Önce get_brand_kit oku, kullanıcıya ne üretileceğini ve yaklaşık krediyi söyle. Hedef platformu "platform" ile ver: oran ona göre seçilir, sonradan kırpma gerekmez. Başarısız olursa kendiliğinden tekrar deneme.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Marka kitine uygun, ayrıntılı görsel tarifi (İngilizce ya da Türkçe). Görselde yazı/logo istemekten kaçın; logo için boş köşe bırak.', maxLength: 4000 },
                    platform: { type: 'string', enum: platformKeys, description: `Hedef platform; oranı belirler (${platformKeys.map((key) => `${key} ${settings.platformAspectRatios[key]}`).join(', ')}).` },
                    aspect_ratio: { type: 'string', enum: aspectRatios, description: 'Platform verilmediyse en-boy oranı.' },
                    model: { type: 'string', enum: settings.imageModels, description: `Varsayılan ${DEFAULT_IMAGE_MODEL}. ${settings.imageModels.map((model) => `${model}: ${IMAGE_MODELS[model].label}`).join('; ')}.` },
                    resolution: { type: 'string', enum: ['1k', '2k', '4k'], description: 'Sadece nano_banana_2_1 için 4k; varsayılan 2k. Sosyal medya için 2k yeterli.' },
                    style: { type: 'string', enum: IMAGE_MODELS.recraft_v4_1.styles, description: 'Sadece recraft_v4_1: standard, vector (logo/ikon/tipografi), utility, utility_vector.' },
                    reference_image: { type: 'string', description: 'İsteğe bağlı referans: "logo" ya da "logo-dark" (kulüp logosu), önceki bir üretim (gen_…) ya da kullanıcının gönderdiği görselin yolu (/opt/data/cache/images/…).' },
                    requested_by: requestedByProp,
                },
                required: ['prompt'],
                additionalProperties: false,
            },
            annotations: { title: 'Görsel üret (kredi harcar)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            handler: (args) => generateImage(args),
        },
        {
            name: 'generate_audio',
            description: `Kulübün Higgsfield hesabıyla TEK bir ses üretir; kredi harcar. kind=speech: metni seslendirir (en fazla ${settings.speechMaxChars} karakter, yaklaşık 1 kredi). kind=music: müzik (en fazla ${settings.musicMaxSec} sn, 60 sn yaklaşık 9 kredi). Başarısız olursa kendiliğinden tekrar deneme.`,
            inputSchema: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['speech', 'music'] },
                    text: { type: 'string', description: 'speech: seslendirilecek metin.', maxLength: settings.speechMaxChars },
                    voice: { type: 'string', enum: voiceKeys, description: `speech: ses (${voiceKeys.map((key) => `${key}: ${settings.voices[key].label ?? key}`).join(', ')}). Varsayılan ${settings.defaultVoice}.` },
                    prompt: { type: 'string', description: 'music: müziğin tarifi (tarz, tempo, duygu).', maxLength: 2000 },
                    duration: { type: 'number', minimum: 3, maximum: settings.musicMaxSec, description: `music: saniye (en fazla ${settings.musicMaxSec}).` },
                    instrumental: { type: 'boolean', description: 'music: sözsüz (varsayılan true).' },
                    requested_by: requestedByProp,
                },
                required: ['kind'],
                additionalProperties: false,
            },
            annotations: { title: 'Ses üret (kredi harcar)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            handler: (args) => generateAudio(args),
        },
        {
            name: 'attach_to_trypost',
            description:
                'Üretilen GÖRSELİN asıl dosyasını (WhatsApp’tan geçmeden, kalite kaybı olmadan) Marmara AI TryPost çalışma alanına yükler: post_id verilirse o gönderiye ekler, verilmezse social_account_id hesabı için yeni taslak oluşturur. Ses dosyaları eklenemez. Kredi harcamaz.',
            inputSchema: {
                type: 'object',
                properties: {
                    generation_id: generationIdProp,
                    post_id: { type: 'string', description: 'Görselin ekleneceği TryPost gönderisinin id’si (taslak).' },
                    social_account_id: { type: 'string', description: 'post_id yoksa: yeni taslağın hesabı (TryPost araçlarından alınan social_account_id).' },
                    content: { type: 'string', description: 'post_id yoksa: yeni taslağın metni (isteğe bağlı).', maxLength: 10000 },
                },
                required: ['generation_id'],
                additionalProperties: false,
            },
            annotations: { title: "TryPost'a ekle", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            handler: (args) => attachToTryPost(args),
        },
    ];

    function brandKit() {
        let text;
        try {
            text = readFileSync(settings.brandKitFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        } catch {
            text = `Marka kiti dosyası bulunamadı (${basename(settings.brandKitFile)}). Temel bilgiler: Marmara Yapay Zeka Kulübü, slogan "Öğren · Paylaş · Üret", renkler ${settings.brandColors.join(', ')}.`;
        }
        const ratios = Object.entries(settings.platformAspectRatios)
            .map(([key, ratio]) => `${key}: ${ratio}`)
            .join(', ');
        return `${text.trim()}\n\n---\nGeçitteki ayarlar: platform oranları ${ratios}. Logo referansı için reference_image "logo" ya da "logo-dark".`;
    }

    function usageText() {
        const usage = usageNumbers();
        const lines = [
            `Bugün (${usage.day}, İstanbul): ${round(usage.dayCredits)}/${limits.dailyCredits} kredi; ${usage.counts.image}/${limits.dailyImages} görsel, ${usage.counts.music}/${limits.dailyMusic} müzik, ${usage.counts.speech}/${limits.dailySpeech} seslendirme.`,
            `Bu ay: ${round(usage.monthCredits)}/${limits.monthlyCredits} kredi.`,
            `Tek istekte en fazla ${limits.maxCreditsPerRequest} kredi; üretimler arası ${limits.cooldownSec} sn.`,
            inFlight || store.pending().length ? 'Şu an bir üretim sürüyor.' : usage.cooldownLeft > 0 ? `Yeni üretim için ${usage.cooldownLeft} sn beklemek gerekiyor.` : 'Yeni üretim başlatılabilir.',
        ];
        const late = store.late();
        if (late.length) lines.push(`Geç kalan üretim var (${late.map((row) => row.id).join(', ')}): Higgsfield'de hâlâ çalışıyor, yeni üretimi engellemiyor ama sınırlara sayılıyor; hazır olunca get_generation ile alınabilir.`);
        const status = auth?.status?.();
        if (status && !status.connected) lines.push('Higgsfield bağlantısı kurulmamış; yöneticinin sunucuda giriş yapması gerekiyor.');
        return lines.join('\n');
    }

    function requireGeneration(id) {
        const row = (store.get(String(id ?? '')));
        if (!row || row.status === 'refused') refuse(MESSAGES.notFound);
        return row;
    }

    async function getGeneration({ generation_id: id }) {
        let row = requireGeneration(id);
        if (['submitting', 'submitted', 'late'].includes(row.status)) {
            await settleRow(row);
            row = store.get(row.id);
        }
        if (row.status === 'completed') return describeResult(row, usageNumbers(), ['(Bu sonuç daha önce başlatılmış üretime ait; yeni kredi harcanmadı.)']);
        if (row.status === 'failed') return failedMessage(row);
        if (row.status === 'unknown' && !row.job_id) return MESSAGES.unmatched(row.id);
        if (row.status === 'unknown') return 'Bu üretimin sonucu bilinmiyor (Higgsfield cevap vermedi). Tekrar denemiyorum.';
        if (row.status === 'late') return MESSAGES.late(row.id);
        return MESSAGES.notReady;
    }

    function originalFile({ generation_id: id }) {
        const row = requireGeneration(id);
        if (row.status !== 'completed' || !row.file) refuse(MESSAGES.notReady);
        const path = exposeToHermes(row, '-original');
        return [
            'Asıl dosyayı belge olarak göndermek için cevabına ayrı satırlarda aynen şunları yaz:',
            `MEDIA:${path}`,
            '[[as_document]]',
            `(${row.mime}, ${(row.bytes / MB).toFixed(1)} MB; belge olarak gönderilen dosya WhatsApp'ta sıkıştırılmaz.)`,
        ].join('\n');
    }

    async function generateImage(args) {
        const model = args.model ?? DEFAULT_IMAGE_MODEL;
        const attempt = { tool: 'generate_image', kind: 'image', model, requestedBy: personBucket(args.requested_by, settings.people) };
        if (/video|seedance|kling|veo|sora|wan|hailuo|minimax/i.test(model)) refuseAttempt(attempt, MESSAGES.video);
        if (!settings.imageModels.includes(model)) refuseAttempt(attempt, MESSAGES.unknownModel(settings.imageModels.join(', ')));
        const spec = IMAGE_MODELS[model];
        const prompt = String(args.prompt ?? '').trim();
        if (!prompt) refuseAttempt(attempt, 'Görsel tarifi boş; ne üretileceğini yaz.');
        if (prompt.length > 4000) refuseAttempt(attempt, 'Görsel tarifi çok uzun (en fazla 4000 karakter).');
        let aspect = args.aspect_ratio ?? '1:1';
        if (args.platform) {
            aspect = settings.platformAspectRatios[args.platform];
            if (!aspect) refuseAttempt(attempt, `Bilinmeyen platform. Seçenekler: ${platformKeys.join(', ')}.`);
        }
        if (!spec.aspectRatios.includes(aspect)) refuseAttempt(attempt, `${model} bu oranı (${aspect}) desteklemiyor. Desteklenenler: ${spec.aspectRatios.join(', ')}.`);
        const resolution = args.resolution ?? '2k';
        if (!spec.resolutions.includes(resolution)) refuseAttempt(attempt, `${model} için çözünürlük ${spec.resolutions.join(' / ')} olabilir.`);
        if (args.reference_image && !spec.references) refuseAttempt(attempt, `${model} referans görsel almıyor; referans için gpt_image_2_6 ya da nano_banana_2_1 kullan.`);

        // Built here from the allowlist: nothing else Hermes sends reaches Higgsfield.
        const params = { model, prompt, aspect_ratio: aspect, batch_size: 1, count: 1, use_unlim: settings.allowUnlim };
        if (settings.allowFreeGens) params.use_free_gens = true;
        if (model === 'gpt_image_2_6') Object.assign(params, { quality: 'high', resolution: '2k', output_format: settings.imageFormat });
        if (model === 'nano_banana_2_1') params.resolution = resolution;
        if (model === 'recraft_v4_1') {
            const style = args.style ?? 'standard';
            if (!spec.styles.includes(style)) refuseAttempt(attempt, `recraft_v4_1 stili ${spec.styles.join(', ')} olabilir.`);
            Object.assign(params, { resolution, model_type: style, colors: settings.brandColors.slice(0, 10) });
        }
        return generate({ ...attempt, params, reference: args.reference_image ?? null });
    }

    async function generateAudio(args) {
        const kind = args.kind;
        if (kind === 'speech') {
            const attempt = { tool: 'generate_audio', kind: 'speech', model: SPEECH_MODEL, requestedBy: personBucket(args.requested_by, settings.people) };
            const text = String(args.text ?? '').trim();
            if (!text) refuseAttempt(attempt, 'Seslendirilecek metin boş.');
            if (text.length > settings.speechMaxChars) refuseAttempt(attempt, `Metin çok uzun; en fazla ${settings.speechMaxChars} karakter seslendirebilirim.`);
            const voiceKey = args.voice ?? settings.defaultVoice;
            const voice = settings.voices[voiceKey];
            if (!voice) refuseAttempt(attempt, `Bu ses yok. Seçenekler: ${voiceKeys.join(', ')}.`);
            const params = { model: SPEECH_MODEL, prompt: text, dialogue: [{ text, voice_type: voice.type ?? 'preset', voice_id: voice.id }], batch_size: 1, count: 1, use_unlim: settings.allowUnlim };
            if (settings.allowFreeGens) params.use_free_gens = true;
            return generate({ ...attempt, params });
        }
        if (kind === 'music') {
            const attempt = { tool: 'generate_audio', kind: 'music', model: MUSIC_MODEL, requestedBy: personBucket(args.requested_by, settings.people) };
            const prompt = String(args.prompt ?? '').trim();
            if (!prompt) refuseAttempt(attempt, 'Müzik tarifi boş; tarz, tempo ve duyguyu yaz.');
            const duration = Math.round(Number(args.duration ?? 30));
            if (!Number.isFinite(duration) || duration < 3) refuseAttempt(attempt, 'Süre en az 3 saniye olmalı.');
            if (duration > settings.musicMaxSec) refuseAttempt(attempt, `Müzik en fazla ${settings.musicMaxSec} saniye olabilir.`);
            const params = { model: MUSIC_MODEL, prompt, duration, force_instrumental: args.instrumental !== false, batch_size: 1, count: 1, use_unlim: settings.allowUnlim };
            if (settings.allowFreeGens) params.use_free_gens = true;
            return generate({ ...attempt, params });
        }
        if (/video/i.test(String(kind))) refuse(MESSAGES.video);
        refuse('kind "speech" (seslendirme) ya da "music" (müzik) olmalı.');
    }

    const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

    async function attachToTryPost({ generation_id: id, post_id: postId, social_account_id: accountId, content }) {
        const row = requireGeneration(id);
        if (row.kind !== 'image') {
            store.addAttachment({ generationId: row.id, project: settings.project ?? '-', status: 'refused', reason: 'audio' });
            refuse(MESSAGES.audioAttach);
        }
        if (!trypost || !settings.project) refuse(MESSAGES.noProject);
        if (row.status !== 'completed' || !row.file) refuse(MESSAGES.notReady);
        const bytes = readFileSync(row.file);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== row.sha256) refuse(MESSAGES.integrity);
        const limitMb = trypost.imageLimitMb ?? TRYPOST_IMAGE_MB;
        if (bytes.length > limitMb * MB) refuse(`Dosya ${(bytes.length / MB).toFixed(1)} MB; TryPost en fazla ${limitMb} MB görsel kabul ediyor. 2k çözünürlükte yeniden üretmeyi öner.`);
        if (postId !== undefined && !SAFE_ID.test(String(postId))) refuse(MESSAGES.postScope);
        if (postId === undefined && (!accountId || !SAFE_ID.test(String(accountId)))) refuse(MESSAGES.needAccount);

        if (postId !== undefined) {
            // The project's token is bound to the Marmara workspace: a post it cannot read is not ours.
            try {
                await trypost.request('GET', `/posts/${postId}`);
            } catch (error) {
                if ([403, 404].includes(error.status)) {
                    store.addAttachment({ generationId: row.id, project: settings.project, postId, sha256, status: 'refused', reason: `scope ${error.status}` });
                    refuse(MESSAGES.postScope);
                }
                throw error;
            }
        }

        const filename = `${row.id}${extname(row.file)}`;
        let upload;
        try {
            upload = await trypost.uploadMedia({ file: new Blob([bytes], { type: row.mime }), filename, mimeType: row.mime });
        } catch (error) {
            store.addAttachment({ generationId: row.id, project: settings.project, postId: postId ?? null, sha256, status: 'failed', reason: String(error.message).slice(0, 300) });
            if (error.status === 422) refuse(`TryPost dosyayı kabul etmedi: ${String(error.message).replace(/^.*?:\s*/, '').slice(0, 160)}`);
            refuse('Dosyayı TryPost’a yükleyemedim (bağlantı sorunu). Biraz sonra tekrar deneyebilirsin.');
        }

        let post;
        try {
            if (postId !== undefined) {
                post = await trypost.request('POST', `/posts/${postId}/media/from-upload`, { upload_token: upload.uploadToken });
            } else {
                post = await trypost.request('POST', '/posts', { status: 'draft', social_account_id: accountId, content: content ?? '', media: [{ upload_token: upload.uploadToken }] });
            }
        } catch (error) {
            store.addAttachment({ generationId: row.id, project: settings.project, postId: postId ?? null, sha256, status: 'failed', reason: String(error.message).slice(0, 300) });
            if (error.status === 404 || error.status === 403) refuse(MESSAGES.postScope);
            if (error.status === 422) refuse(`TryPost kabul etmedi: ${String(error.body?.message ?? error.message).slice(0, 160)}`);
            refuse('Görsel yüklendi ama gönderiye eklenemedi; biraz sonra tekrar deneyebilirsin.');
        }
        const data = post?.data ?? post ?? {};
        const finalId = postId ?? data.id ?? null;
        store.addAttachment({ generationId: row.id, project: settings.project, postId: finalId, createdPost: postId === undefined, sha256, status: 'attached' });
        log('info', 'studio image attached to TryPost', row.id, String(finalId));
        const what = postId !== undefined ? 'gönderiye eklendi' : `yeni taslak oluşturuldu (post_id: ${finalId})`;
        const note = row.mime === 'image/png' ? ' Not: TryPost PNG dosyaları kendi tarafında JPEG’e (kalite 100, aynı boyut) çeviriyor.' : '';
        return `Görselin asıl dosyası (${row.mime}, ${(bytes.length / MB).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…) WhatsApp’tan geçmeden TryPost’a yüklendi ve ${what}.${note}`;
    }

    return {
        tools,
        /** Runs a tool; { text, isError }. Unknown names throw (the server answers with a JSON-RPC error). */
        async callTool(name, args = {}) {
            const tool = tools.find((item) => item.name === name);
            if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { unknownTool: true });
            try {
                return { text: await tool.handler(args ?? {}), isError: false };
            } catch (error) {
                if (error.userMessage) return { text: error.userMessage, isError: true };
                log('error', 'studio tool failed', name, error.message);
                return { text: 'Stüdyoda beklenmeyen bir hata oldu; kendiliğimden tekrar denemiyorum. Biraz sonra tekrar deneyebilirsin.', isError: true };
            }
        },
        usage: usageNumbers,
        /** Background check of sent and late jobs (completes or fails finished ones, moves stale ones to 'late'/'unknown'); skipped while a generation is being sent. */
        async checkPending() {
            if (inFlight) return;
            await settlePending({ late: true });
        },
    };
}
