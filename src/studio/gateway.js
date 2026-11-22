import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_RESOLUTION, IMAGE_MODELS, MUSIC_MODEL, SPEECH_MODEL, UNKNOWN_PERSON, personBucket } from './config.js';
import { answerExcerpt, parseCredits, parseJob, parseJobIds, parseMediaId, parseUpload, rawAnswer } from './higgsfield.js';
import { CORNER_NAMES, CORNER_PROMPT, DEFAULT_LOGO_CORNER, LOGO_CORNERS } from './compose.js';

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
 *
 * Posters are finished by the model: Hermes writes a creative brief, and the
 * gateway appends only the essentials in a fixed phrasing: the exact headline
 * and subline (baslik, alt_metin) with correct Turkish letters, the club name
 * small, the real club logo PNG (uploaded once, media id cached in studio.db)
 * as an image reference to be placed as given (a corner only when one is
 * asked for), and the brand palette as a soft hint. Layout and style are left
 * to the model. secenek: 2 sends two independent jobs of the same brief with
 * different style directions, both counted against every limit. If the model's logo comes out
 * wrong, add_logo composites the real PNG with ImageMagick (no credits): that
 * makes a "final" PNG next to the untouched original, and the preview,
 * get_original_file and attach_to_trypost use the final when there is one.
 * edit_image is image-to-image with gpt_image_2_6 on an earlier generation or a
 * picture the user sent, through the same limits as generate_image.
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
const BASLIK_MAX = 120;
const ALT_METIN_MAX = 200;
/** edit_image always uses GPT Image 2.6 (image-to-image with references). */
const EDIT_MODEL = 'gpt_image_2_6';

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
    noCompositor: 'Logo ekleme bu sunucuda ayarlı değil (ImageMagick yok); yöneticiye haber ver.',
    logoFailed: 'Logoyu görsele ekleyemedim; görsel değişmedi. Yöneticiye haber ver.',
    logoFile: 'Kulüp logosu dosyası sunucuda bulunamadı; yöneticiye haber ver.',
    notImage: 'Bu işlem sadece görseller için.',
    // A picture the user sent (kaynak_gorsel / reference_image) that cannot be read: the cause, named.
    referenceMissing: (name) => `Gönderilen görseli açamadım: dosya bulunamadı (${name}). Yol yanlış olabilir ya da dosya sunucudan silinmiş; Hermes'in verdiği yolu aynen kullan, yine bulunamazsa kullanıcıdan görseli WhatsApp'tan tekrar göndermesini iste.`,
    referenceDenied: (name) => `Gönderilen görseli açamadım: izin yok (stüdyo ${name} dosyasını okuyamıyor). Bu bir sunucu ayarı sorunu; görseli tekrar göndermek işe yaramaz. Kullanıcıya bunu söyle ve yöneticiye haber vermesini iste.`,
    referenceType: (what) => `Gönderilen dosyayı açamadım: desteklenmeyen tür (${what}). Sadece PNG, JPEG ya da WebP görseller kullanılabilir.`,
    referenceOutside: 'Bu dosya referans olarak kullanılamaz; sadece kullanıcının WhatsApp’tan gönderdiği görseller ya da kulüp logosu kullanılabilir.',
    editSource: 'Düzenlenecek görseli bulamadım. Önceki bir üretimin generation_id’sini (gen_…) ya da kullanıcının gönderdiği görselin yolunu ver.',
    stillPreparing: (id) => `Üretim hâlâ hazırlanıyor (generation_id: ${id}). Kullanıcıya biraz sürdüğünü ve hazır olunca önizlemenin WhatsApp'tan kendiliğinden geleceğini söyle; sorarsa get_generation ile sonucu al. Yeni bir üretim başlatma.`,
    variantsCount: (left) => `Bugün yalnızca ${left} görsel hakkı kaldı; iki seçenek için yetmiyor. Tek görsel üretebilirim.`,
    variants: 'secenek 1 ya da 2 olabilir (en fazla 2 seçenek).',
};

/** The club's name as it is written on posters. */
export const CLUB_NAME = 'Marmara Yapay Zeka Kulübü';
const TURKISH_LETTERS = 'ç ğ ı İ ö ş ü (and Ç Ğ Ö Ş Ü)';

/** One line of text for the image, NFC (precomposed Turkish letters), no control characters, double quotes made single. */
export function posterText(value) {
    return String(value ?? '')
        .normalize('NFC')
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
        .replace(/["“”„«»]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The logo line: the reference is the real logo, to be placed as given. The corner only when the user or
 * Hermes chose one (`corner`); otherwise the model picks the spot that suits its composition.
 */
const logoInstruction = (corner, which) =>
    `Logo: ${which} is the official ${CLUB_NAME} logo. Place it once, exactly as given (same shapes, colours and proportions; do not redraw, restyle, distort or crop it, and add no other logo or emblem), ${corner ? `in the ${CORNER_PROMPT[corner]} corner` : 'wherever it suits the composition'}, clearly visible on an uncluttered area.`;

/** A soft colour hint: the brand palette as inspiration, not a rule. */
const paletteHint = (colors) => `Colour palette inspired by the club's brand colours (${colors.join(', ')}); use them freely, as inspiration rather than a rule.`;

/** The poster style directions secenek: 2 draws from when Hermes gives none: two different ones per request. */
export const STYLE_DIRECTIONS = [
    'bold typography-led poster, the words as the main visual',
    'glossy 3D render with soft studio lighting',
    'collage / mixed media with paper textures and cut-outs',
    'retro Y2K aesthetic with chrome and playful shapes',
    'minimalist Swiss design, strict grid, strong type',
    'isometric illustration with a small detailed world',
    'photoreal editorial photography look',
    'hand-drawn flat illustration, warm and friendly',
    'futuristic interface / HUD aesthetic',
    'layered paper-cut art with depth and shadows',
    'flowing gradient mesh with abstract organic forms',
];

/**
 * The prompt sent for generate_image: the caller's creative brief, then (only when there is a headline or a
 * logo) a short fixed block: the exact text to render with correct Turkish letters, the club name small, the
 * real logo as given, and the brand palette as a soft hint. Layout, typography and style stay the model's call.
 * `logo` false: no logo line; `logoCorner` null: the model places the logo. `style`: an extra style direction.
 */
export function buildImagePrompt({ prompt, baslik = null, altMetin = null, logo = false, logoCorner = null, style = null, colors = null }) {
    const parts = [String(prompt).trim()];
    if (style) parts.push(`Style direction for this version: ${style}.`);
    if (baslik) {
        const lines = [
            `Text to render, exactly as written and no other words. It is Turkish: keep every letter, with the correct Turkish characters ${TURKISH_LETTERS}, nothing missing or replaced, no extra punctuation.`,
            `Headline: "${baslik}"`,
        ];
        if (altMetin) lines.push(`Subline: "${altMetin}"`);
        lines.push(`Club name, small: "${CLUB_NAME}"`);
        lines.push('Layout and typography are up to you; keep all text legible and uncut.');
        parts.push(lines.join('\n'));
    }
    if (logo || logoCorner) parts.push(logoInstruction(logoCorner, 'the last reference image'));
    if ((baslik || logo || logoCorner) && colors?.length) parts.push(paletteHint(colors));
    return parts.join('\n\n');
}

/** The prompt sent for edit_image: change only what the instruction says, keep the rest. */
export function buildEditPrompt({ talimat, logo = false, logoCorner = null }) {
    const parts = [
        `Edit the first reference image. Change only this: ${String(talimat).trim()}`,
        `Keep everything else as it is: composition, colours, style, layout and any existing text. Any text you add or change must be spelled exactly as given, with the correct Turkish characters ${TURKISH_LETTERS}.`,
    ];
    if (logo || logoCorner) {
        const where = logoCorner ? `in the ${CORNER_PROMPT[logoCorner]} corner` : 'where it already is (or, if there is none, wherever it suits the composition)';
        parts.push(`Logo: the last reference image is the official ${CLUB_NAME} logo. The image must show it once, exactly as given, ${where}, clearly visible on an uncluttered area. If the logo in the image differs from it, replace it with a faithful copy; do not redraw, restyle or distort it, and add no other logo or emblem.`);
    }
    return parts.join('\n\n');
}

/** The allowed aspect ratio closest to width/height. */
export function nearestAspect(width, height, ratios) {
    const target = Math.log(width / height);
    let best = ratios[0];
    let gap = Infinity;
    for (const ratio of ratios) {
        const [w, h] = ratio.split(':').map(Number);
        const d = Math.abs(Math.log(w / h) - target);
        if (d < gap) [best, gap] = [ratio, d];
    }
    return best;
}

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

/** The image type of a file's first bytes: image/png, image/jpeg, image/webp, or null. */
export function imageMime(bytes) {
    if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

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
 * fetchImpl (downloads, presigned uploads), sleep, log, notify (createStudioNotifier, or null: late
 * generations are then only returned by get_generation),
 * compositor (createLogoCompositor, or null: add_logo then refuses).
 */
export function createStudioGateway({ settings, store, higgsfield, auth = null, trypost = null, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), log = () => {}, notify = null, compositor = null }) {
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
        store.insert({ id: newId(), day: today(), month: today().slice(0, 7), tool: attempt.tool, kind: attempt.kind, model: attempt.model, params: attempt.params ? publicParams(attempt.params) : null, estimated, status: 'refused', reason: message, requestedBy: attempt.requestedBy, summary: attempt.summary });
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

    /**
     * The Higgsfield media id of a club logo PNG (variant "logo" or "logo-dark"): uploaded once with
     * media_upload, then the id cached in studio.db (assets) until the file changes or logoMediaMaxDays pass.
     */
    async function logoMedia(variant) {
        const file = join(settings.logoDir, `${variant}.png`);
        let bytes;
        try {
            bytes = readFileSync(file);
        } catch {
            refuse(MESSAGES.logoFile);
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const key = `logo:${variant}`;
        const cached = store.getAsset(key);
        if (cached && cached.sha256 === sha256 && now() - cached.created_at < settings.logoMediaMaxDays * 86_400_000) return cached.media_id;
        const mediaId = await uploadReferenceFile(file);
        store.setAsset(key, mediaId, sha256);
        log('info', 'studio logo uploaded to Higgsfield', variant, mediaId);
        return mediaId;
    }

    /**
     * The real path of a picture the user sent, or a refusal naming the cause. Strict: the path as
     * given must be inside one of settings.referenceDirs, its realpath must still be inside one (no
     * symlink out), it must be a regular file with a PNG/JPEG/WebP extension whose first bytes are
     * that same image type, and the studio must be able to open it. A path outside the allowed dirs
     * (Hermes' native-vision copy under cache/documents/native-inputs/…) is never opened itself: only
     * its basename, if it is a plain image file name, is looked up directly inside each allowed dir
     * (no recursion), and a match there passes the same checks. Every refusal is logged with the
     * input path and a reason code.
     */
    function userImagePath(value) {
        const input = String(value);
        try {
            return checkUserImage(input);
        } catch (error) {
            if (error instanceof Refusal) log('warn', 'studio user image refused', input, error.reasonCode ?? 'unknown');
            throw error;
        }
    }

    const USER_IMAGE_NAME = /^[A-Za-z0-9_.-]{1,128}\.(jpe?g|png|webp)$/i;

    function checkUserImage(input) {
        const fail = (message, code) => {
            const error = new Refusal(message);
            error.reasonCode = code;
            throw error;
        };
        const inside = (path, root) => path.startsWith(root.endsWith(sep) ? root : root + sep);
        let given = resolve(input);
        const roots = settings.referenceDirs.map((dir) => resolve(dir));
        if (!roots.some((root) => inside(given, root))) {
            // Fallback: the same file name directly inside an allowed dir (e.g. the WhatsApp media copy).
            const name = basename(input);
            if (!USER_IMAGE_NAME.test(name) || name.includes('..') || /[\\/]/.test(name)) fail(MESSAGES.referenceOutside, 'outside');
            const found = roots.map((root) => join(root, name)).find((candidate) => {
                try {
                    lstatSync(candidate);
                    return true;
                } catch {
                    return false;
                }
            });
            if (!found) fail(MESSAGES.referenceOutside, 'outside-basename-not-found');
            given = found;
        }
        const name = basename(given);
        const cause = (error) => {
            if (error?.code === 'EACCES' || error?.code === 'EPERM') return [MESSAGES.referenceDenied(name), 'denied'];
            if (error?.code === 'ELOOP') return [MESSAGES.referenceOutside, 'symlink-loop'];
            return [MESSAGES.referenceMissing(name), 'missing'];
        };
        let real;
        try {
            real = realpathSync(given);
        } catch (error) {
            fail(...cause(error));
        }
        const realRoots = roots.flatMap((root) => {
            try {
                return [realpathSync(root)];
            } catch {
                return [];
            }
        });
        if (!realRoots.some((root) => inside(real, root))) fail(MESSAGES.referenceOutside, 'symlink-outside');
        const ext = extname(real).slice(1).toLowerCase();
        if (!REFERENCE_EXT.has(ext)) fail(MESSAGES.referenceType(ext ? `.${ext}` : 'uzantısız dosya'), 'extension');
        const header = Buffer.alloc(16);
        let fd;
        try {
            fd = openSync(real, 'r');
            if (!fstatSync(fd).isFile()) fail(MESSAGES.referenceType('dosya değil'), 'not-file');
            readSync(fd, header, 0, header.length, 0);
        } catch (error) {
            if (error instanceof Refusal) throw error;
            fail(...cause(error));
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
        const sniffed = imageMime(header);
        if (sniffed !== MIME_BY_EXT[ext]) fail(MESSAGES.referenceType(sniffed ? `.${ext} uzantılı ${sniffed}` : `.${ext} uzantılı ama görsel değil`), 'magic-bytes');
        return real;
    }

    /** A Higgsfield media id (or job id) for a reference the caller named. */
    async function resolveReference(reference) {
        const value = String(reference).trim();
        if (value === 'logo' || value === 'logo-dark') return logoMedia(value);
        if (/^gen_[a-z0-9]+$/i.test(value)) {
            const row = store.get(value);
            if (!row || row.kind !== 'image' || row.status !== 'completed' || !row.job_id) refuse('Referans olarak verilen üretimi bulamadım.');
            // A generation with the real logo composited (add_logo): that file is what the user saw.
            if (row.final_file && existsSync(row.final_file)) return uploadReferenceFile(row.final_file);
            return row.job_id;
        }
        if (value.startsWith('/')) return uploadReferenceFile(userImagePath(value));
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
    function exposeToHermes(row, suffix = '', file = row.file) {
        mkdirSync(settings.previewDir, { recursive: true });
        const name = `${row.id}${suffix}${extname(file)}`;
        copyFileSync(file, join(settings.previewDir, name));
        return join(settings.hermesPreviewDir, name);
    }

    /**
     * The file shown and sent for an image: the "final" (club logo composited by add_logo) when there is
     * one and `original` is not asked for, else the original. { file, mime, bytes, sha256, final }.
     */
    function deliverable(row, { original = false } = {}) {
        if (!original && row.kind === 'image' && row.final_file && existsSync(row.final_file)) {
            return { file: row.final_file, mime: 'image/png', bytes: row.final_bytes, sha256: row.final_sha256, final: true };
        }
        return { file: row.file, mime: row.mime, bytes: row.bytes, sha256: row.sha256, final: false };
    }

    function describeResult(row, usage, extra = []) {
        const lines = [`Üretim tamamlandı. generation_id: ${row.id}`];
        const params = row.params ? JSON.parse(row.params) : {};
        const credits = row.actual_credits ?? row.estimated_credits;
        lines.push(`Model: ${row.model}${params.aspect_ratio ? `, oran: ${params.aspect_ratio}` : ''}. Kredi: yaklaşık ${round(credits ?? 0)}.`);
        const meta = [row.mime, row.width ? `${row.width}x${row.height}` : null, `${(row.bytes / MB).toFixed(1)} MB`].filter(Boolean).join(', ');
        if (row.kind === 'image') {
            const shown = deliverable(row);
            if (shown.bytes <= settings.whatsappPreviewMaxMb * MB) {
                lines.push('Kullanıcıya önizlemeyi göstermek için cevabına ayrı bir satırda aynen şunu yaz:', `MEDIA:${exposeToHermes(row, shown.final ? '-final-preview' : '-preview', shown.file)}`);
                lines.push('WhatsApp görseli sıkıştırır; bu sadece önizleme.');
            } else {
                lines.push('Dosya WhatsApp önizlemesi için fazla büyük; kullanıcı görmek isterse get_original_file ile belge olarak gönder.');
            }
            lines.push(`Asıl dosya sunucuda değiştirilmeden saklı (${meta}). Gönderiye eklemek için attach_to_trypost kullan (WhatsApp'tan geçmez, kalite kaybı olmaz). Kullanıcı asıl dosyayı isterse get_original_file.`);
            if (shown.final) lines.push(`Gerçek kulüp logosu eklenmiş hali (${CORNER_NAMES[row.logo_corner] ?? ''} köşe) kullanılıyor; logosuz asıl hali de saklı (logosuz: true).`);
            const text = params.poster;
            if (text?.baslik) {
                lines.push(`Görseldeki yazıyı kontrol et: başlık “${text.baslik}”${text.alt_metin ? `, alt metin “${text.alt_metin}”` : ''}. Kullanıcı yazının yanlış olduğunu söylerse edit_image ile düzeltmeyi (ya da yeniden üretmeyi) teklif et; kendiliğinden tekrar üretme.`);
            }
            if ((row.logo_corner || params.logo) && !shown.final) lines.push('Logo modele referans olarak verildi. Logo bozuk ya da yanlış çıktıysa add_logo ile gerçek logo kredi harcamadan eklenebilir.');
        } else {
            if (row.bytes <= WHATSAPP_AUDIO_MAX) {
                lines.push('Kullanıcıya dinletmek için cevabına ayrı bir satırda aynen şunu yaz:', `MEDIA:${exposeToHermes(row)}`);
            }
            lines.push(`Ses dosyası saklandı (${meta}); sosyal medya gönderisine tek başına eklenemez, ileride videoda kullanılabilir.`);
        }
        lines.push(...extra);
        if (usage) lines.push(remainingLine(usage, row.kind));
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

    /**
     * The one path every generation takes. `attempt.variants` (secenek: 2): several independent jobs of the
     * same request, each with its own params (prompt); every check below counts all of them, and the call
     * waits for all. Without it, one job.
     */
    async function generate(attempt) {
        const { kind, requestedBy } = attempt;
        if (inFlight) refuseAttempt(attempt, MESSAGES.busy);
        inFlight = true;
        try {
            const variants = attempt.variants ?? [{ params: attempt.params }];
            const n = variants.length;
            // A job sent earlier may still be running (the call that sent it answered "still preparing").
            const [pending] = await settlePending();
            if (pending) refuseAttempt(attempt, MESSAGES.pending(pending.id));
            const before = usageNumbers();
            if (before.cooldownLeft > 0) refuseAttempt(attempt, MESSAGES.cooldown(before.cooldownLeft));
            const dailyCount = { image: [limits.dailyImages, MESSAGES.dailyImages], music: [limits.dailyMusic, MESSAGES.dailyMusic], speech: [limits.dailySpeech, MESSAGES.dailySpeech] }[kind];
            if (before.counts[kind] + n > dailyCount[0]) refuseAttempt(attempt, n > 1 && before.counts[kind] < dailyCount[0] ? MESSAGES.variantsCount(dailyCount[0] - before.counts[kind]) : dailyCount[1]);
            if (before.monthCredits >= limits.monthlyCredits) refuseAttempt(attempt, MESSAGES.monthlyCredits);

            // References in order (the prompt names "the first" / "the last" reference image); the same for every variant.
            const references = attempt.references ?? (attempt.reference ? [attempt.reference] : []);
            let medias = null;
            if (references.length) {
                medias = [];
                for (const reference of references) {
                    let value;
                    try {
                        value = await resolveReference(reference);
                    } catch (error) {
                        // A reference that cannot be used (a user picture refused, an unknown gen_…): recorded like the other refusals.
                        if (error instanceof Refusal) refuseAttempt(attempt, error.userMessage);
                        throw error;
                    }
                    medias.push({ value, role: 'image_references' });
                }
            }
            const all = variants.map((variant) => ({ ...variant, params: { ...variant.params, ...(medias ? { medias } : {}) } }));
            const params = all[0].params;
            const estimateTool = kind === 'image' ? 'estimate_image_cost' : 'estimate_audio_cost';
            let estimate = null;
            try {
                // The variants differ only in their prompt: one estimate is the cost of each.
                const answer = await higgsfield.call(estimateTool, { params });
                estimate = answer.isError ? null : parseCredits(answer);
            } catch (error) {
                if (error.notConnected) throw error;
                log('warn', 'studio estimate failed', error.message);
            }
            if (estimate === null || !Number.isFinite(estimate)) refuseAttempt({ ...attempt, params }, MESSAGES.noEstimate);
            const cost = round(estimate);
            const total = round(cost * n);
            if (cost > limits.maxCreditsPerRequest) refuseAttempt({ ...attempt, params }, MESSAGES.tooExpensive(cost, limits.maxCreditsPerRequest), total);
            const usage = usageNumbers();
            if (usage.dayCredits + total > limits.dailyCredits) refuseAttempt({ ...attempt, params }, MESSAGES.dailyCredits(usage.remaining.credits), total);
            if (usage.monthCredits + total > limits.monthlyCredits) refuseAttempt({ ...attempt, params }, MESSAGES.monthlyCredits, total);
            // Best-effort (requested_by is the model's word); a missing or unknown one shares the 'bilinmiyor' cap.
            const spent = store.personCredits(usage.day, requestedBy);
            if (spent + total > limits.perPersonDailyCredits) {
                const left = round(Math.max(0, limits.perPersonDailyCredits - spent));
                refuseAttempt({ ...attempt, params }, requestedBy === UNKNOWN_PERSON ? MESSAGES.unknownPerson(left) : MESSAGES.perPerson(left), total);
            }

            const deadline = now() + settings.jobTimeoutSec * 1000;
            const sent = [];
            let stopped = null;
            for (const variant of all) {
                try {
                    sent.push({ ...variant, ...(await sendOne(attempt, variant, usage.day, cost)) });
                } catch (error) {
                    // A variant that failed to send: nothing after it is sent (no retries, no surprises).
                    if (!sent.length || !error.userMessage) throw error;
                    stopped = error.userMessage;
                    break;
                }
            }

            const results = [];
            for (const item of sent) results.push({ ...item, row: await finish(item.id, item.jobId, deadline) });
            if (n === 1) {
                const [{ row }] = results;
                if (row.status === 'completed') return describeResult(row, usageNumbers());
                if (row.status === 'failed') refuse(failedMessage(row));
                // The requester is told on WhatsApp when the background check finishes it (notifyFinished).
                store.markNotify(row.id, null, 'waiting');
                return MESSAGES.stillPreparing(row.id);
            }
            const lines = [`${n} seçenek istendi; her biri ayrı bir üretim ve sınırlara ayrı sayılıyor. Kullanıcıya iki önizlemeyi de göster ve hangisini beğendiğini sor.`];
            results.forEach(({ row, label }, index) => {
                lines.push('', `Seçenek ${index + 1}${label ? ` (${label})` : ''}:`);
                if (row.status === 'completed') lines.push(describeResult(row, null));
                else if (row.status === 'failed') lines.push(failedMessage(row));
                else {
                    store.markNotify(row.id, null, 'waiting');
                    lines.push(MESSAGES.stillPreparing(row.id));
                }
            });
            if (stopped) lines.push('', `Seçenek ${sent.length + 1} gönderilemedi: ${stopped}`);
            lines.push('', remainingLine(usageNumbers(), kind));
            return lines.join('\n');
        } finally {
            inFlight = false;
        }
    }

    /** Records and sends one job; { id, jobId }. Never sent twice: a lost answer is 'unknown' and counted. */
    async function sendOne(attempt, { params, record = {}, logoCorner = null }, day, cost) {
        const id = newId();
        // `record`: what the gateway keeps about the request beyond what is sent (headline, edit source).
        store.insert({ id, day, month: day.slice(0, 7), tool: attempt.tool, kind: attempt.kind, model: params.model, params: { ...publicParams(params), ...(attempt.record ?? {}), ...record }, estimated: cost, status: 'submitting', requestedBy: attempt.requestedBy, summary: attempt.summary, logoCorner: logoCorner ?? attempt.logoCorner ?? null });
        let answer;
        try {
            // edit_image is gpt_image_2_6 image-to-image: Higgsfield's generate_image with the image as a reference.
            answer = await higgsfield.call(attempt.higgsfieldTool ?? attempt.tool, { params, context: 'Kulüp sosyal medya içeriği için tek üretim.' });
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
        return { id, jobId };
    }

    // ---- approval card hint and "ready" notification ------------------------------------------

    /**
     * What the WhatsApp approval card shows before a studio tool runs (the Hermes plugin
     * echo_onay_tr asks GET /approval-hint): the aspect ratio and the approximate credits. Higgsfield
     * is not asked (the card must come at once); the latest real estimate of the same model and
     * resolution is used when there is one, else settings.approxCredits. Nothing is recorded.
     */
    function approvalHint(tool, args = {}) {
        const hint = {};
        if (tool === 'generate_image' || tool === 'edit_image') {
            const model = tool === 'edit_image' ? EDIT_MODEL : settings.imageModels.includes(args.model) ? args.model : DEFAULT_IMAGE_MODEL;
            const resolution = ['1k', '2k', '4k'].includes(args.resolution) ? args.resolution : args.yuksek_cozunurluk === true ? '2k' : DEFAULT_IMAGE_RESOLUTION;
            let sourceAspect = null;
            if (tool === 'edit_image' && typeof args.generation_id === 'string') {
                const source = store.get(args.generation_id);
                sourceAspect = source?.params ? JSON.parse(source.params).aspect_ratio ?? null : null;
            }
            const aspect = (args.platform && settings.platformAspectRatios[args.platform]) || (typeof args.aspect_ratio === 'string' ? args.aspect_ratio : sourceAspect ?? '1:1');
            hint.aspect_ratio = aspect;
            hint.resolution = resolution;
            const seen = store.recentEstimates('image', model).find((row) => {
                const params = row.params ? JSON.parse(row.params) : {};
                return (params.resolution ?? '2k') === resolution;
            });
            const credits = seen?.estimated_credits ?? settings.approxCredits.image[model]?.[resolution];
            // secenek: 2 (generate_image only): two generations, twice the credits.
            const count = tool === 'generate_image' && args.secenek === 2 ? 2 : 1;
            if (count > 1) hint.count = count;
            if (Number.isFinite(credits)) hint.credits = round(credits * count);
        } else if (tool === 'generate_audio') {
            if (args.kind === 'speech') hint.credits = round(settings.approxCredits.speech);
            if (args.kind === 'music') {
                const duration = Math.min(Math.max(Math.round(Number(args.duration ?? 30)) || 30, 3), settings.musicMaxSec);
                hint.duration = duration;
                hint.credits = round((settings.approxCredits.musicPerMinute * duration) / 60);
            }
        }
        return hint;
    }

    const READY_ICON = { image: '🎨', speech: '🔊', music: '🎵' };
    const KIND_NAME = { image: 'Görsel', speech: 'Seslendirme', music: 'Müzik' };
    // Meta's customer-service window is 24 h from the person's last message; a generation this old is not pushed.
    const NOTIFY_MAX_AGE_MS = 23 * 3_600_000;

    function readyText(row) {
        const what = row.summary || KIND_NAME[row.kind] || 'Üretim';
        if (row.status === 'completed') {
            const next = row.kind === 'image' ? "Gönderiye eklemek ya da değiştirmek için bana yazman yeterli." : 'Dinleyip ne yapmak istediğini bana yazabilirsin.';
            return `${READY_ICON[row.kind] ?? '✅'} ${what} hazır.\n${next}`;
        }
        return `❌ ${what} üretilemedi. Kendiliğimden tekrar denemiyorum; istersen isteği değiştirip yeniden başlatabiliriz.`;
    }

    /** Tells requesters about generations that finished after their call answered "still preparing". One attempt each. */
    async function notifyFinished() {
        for (const row of store.toNotify()) {
            if (!notify || row.requested_by === UNKNOWN_PERSON || !row.requested_by) {
                store.markNotify(row.id, 'waiting', 'skipped');
                continue;
            }
            if (now() - row.created_at > NOTIFY_MAX_AGE_MS) {
                store.markNotify(row.id, 'waiting', 'skipped');
                log('info', 'studio ready notification skipped (older than the WhatsApp window)', row.id);
                continue;
            }
            // 'sending' first: a crash mid-send never sends twice.
            if (!store.markNotify(row.id, 'waiting', 'sending')) continue;
            const shown = row.status === 'completed' && row.file ? deliverable(row) : null;
            const media = shown ? { file: shown.file, mime: shown.mime } : {};
            let result;
            try {
                result = await notify({ requestedBy: row.requested_by, text: readyText(row), ...media });
            } catch (error) {
                result = { ok: false, reason: error.message };
            }
            store.markNotify(row.id, 'sending', result?.ok ? 'sent' : 'failed');
            log(result?.ok ? 'info' : 'warn', `studio ready notification ${result?.ok ? 'sent' : 'failed'}`, row.id, row.requested_by, result?.ok ? '' : String(result?.reason ?? ''));
        }
    }

    const summaryOf = (value) => {
        const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
        return text ? text.slice(0, 200) : null;
    };

    // ---- tools ------------------------------------------------------------------------------

    const voiceKeys = Object.keys(settings.voices);
    const aspectRatios = [...new Set(settings.imageModels.flatMap((model) => IMAGE_MODELS[model].aspectRatios))];
    const platformKeys = Object.keys(settings.platformAspectRatios);
    const requestedByProp = {
        type: 'string',
        description: `İsteyen kişinin Echo kişi anahtarı (ör. "yasir"). Sadece kayıt ve kişi başı sınır için; kimlik doğrulaması değildir. Boş ya da bilinmeyen anahtar ortak "${UNKNOWN_PERSON}" sınırından düşer.`,
    };
    // Shown on the WhatsApp approval card (the Hermes plugin echo_onay_tr) and in the "ready" message of a
    // late generation. Display only: it never reaches Higgsfield or TryPost.
    const ozetProp = { type: 'string', maxLength: 200, description: 'Kullanıcıya gösterilecek tek satırlık Türkçe özet (ör. "8 Mart Dünya Kadınlar Günü afişi"). Onay mesajında ve "hazır" bildiriminde görünür; her zaman doldur.' };
    const generationIdProp = { type: 'string', description: 'generate_image / edit_image / generate_audio sonucundaki generation_id (gen_…).' };
    const logosuzProp = { type: 'boolean', description: 'true: add_logo ile eklenen logodan önceki asıl hali kullan. Varsayılan: logolu hali varsa o.' };

    const tools = [
        {
            name: 'get_brand_kit',
            description: 'Marmara Yapay Zeka Kulübü marka kiti: kimlik, logo, gönderi metni ipuçları, platform oranları ve çözünürlük. Görsel ya da ses üretmeden önce mutlaka oku.',
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
            inputSchema: { type: 'object', properties: { generation_id: generationIdProp, logosuz: logosuzProp }, required: ['generation_id'], additionalProperties: false },
            annotations: { title: 'Asıl dosya', readOnlyHint: true, openWorldHint: false },
            handler: (args) => originalFile(args),
        },
        {
            name: 'generate_image',
            description:
                'Kulübün Higgsfield hesabıyla yeni bir görsel üretir (secenek: 2 ile farklı stilde iki ayrı görsel); kredi harcar (varsayılan 1k: görsel başı yaklaşık 1,5 kredi; 2k: 2-3; Recraft 8). Önce get_brand_kit oku, kullanıcıya ne üretileceğini ve yaklaşık krediyi söyle. "Yeni / farklı / daha modern / baştan / alternatif" istekleri için bunu kullan, edit_image değil. Hedef platformu "platform" ile ver: oran ona göre seçilir, sonradan kırpma gerekmez. "ozet" alanına Türkçe tek satırlık özet yaz. Başarısız olursa kendiliğinden tekrar deneme.',
            inputSchema: {
                type: 'object',
                properties: {
                    prompt: { type: 'string', description: 'Sanat yönetmeni brifi (İngilizce daha iyi): konsept, duygu, stil ve bir kompozisyon fikri; yerleşim kararlarını modele bırak. Başlık ve alt metni burada değil baslik/alt_metin alanlarında ver; geçit onları aynen yazdırır.', maxLength: 4000 },
                    baslik: { type: 'string', maxLength: BASLIK_MAX, description: 'Afişin Türkçe başlığı, görselde aynen yazılacak metin (ör. "8 Mart Dünya Kadınlar Günü"). Türkçe karakterleri doğru yaz. Verilirse görsele küçük harflerle "Marmara Yapay Zeka Kulübü" de yazılır.' },
                    alt_metin: { type: 'string', maxLength: ALT_METIN_MAX, description: 'İsteğe bağlı kısa alt satır (tarih, yer, slogan), görselde aynen yazılır. baslik ile birlikte verilir.' },
                    logo: { type: 'boolean', description: 'Varsayılan true (afişler için): gerçek kulüp logosu modele referans olarak verilir, olduğu gibi ve net görünür yerleştirilmesi istenir. Sadece logosuz görsel istenirse false.' },
                    logo_konum: { type: 'string', enum: LOGO_CORNERS, description: 'İsteğe bağlı köşe; sadece kullanıcı ya da tasarım belirli bir köşe isterse ver. Verilmezse logonun yerini model kompozisyona göre seçer.' },
                    logo_zemin: { type: 'string', enum: ['koyu', 'acik'], description: 'Logo köşesinin zemini: koyu (lacivert/koyu; beyaz yazılı logo, varsayılan) ya da acik (açık zemin; lacivert yazılı logo).' },
                    platform: { type: 'string', enum: platformKeys, description: `Hedef platform; oranı belirler (${platformKeys.map((key) => `${key} ${settings.platformAspectRatios[key]}`).join(', ')}).` },
                    aspect_ratio: { type: 'string', enum: aspectRatios, description: 'Platform verilmediyse en-boy oranı.' },
                    model: { type: 'string', enum: settings.imageModels, description: `Varsayılan ${DEFAULT_IMAGE_MODEL}. ${settings.imageModels.map((model) => `${model}: ${IMAGE_MODELS[model].label}`).join('; ')}. Stile göre seç (ör. fotogerçekçi ya da editoryal için nano_banana_2_1).` },
                    secenek: { type: 'integer', enum: [1, 2], description: 'Varsayılan 1. 2: kullanıcı "birkaç seçenek / alternatifler" isterse aynı brifi iki farklı stilde iki ayrı görsel olarak üretir; her biri ayrı kredi ve sınırlara ayrı sayılır (en fazla 2).' },
                    stiller: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 2, description: 'secenek: 2 ile isteğe bağlı: iki seçeneğin stil yönleri (İngilizce, birbirinden farklı; ör. ["bold typography-led poster", "isometric 3D illustration"]). Verilmezse geçit iki farklı stil seçer.' },
                    resolution: { type: 'string', enum: ['1k', '2k', '4k'], description: 'Varsayılan 1k (sosyal medya için yeterli, en ucuzu). 2k sadece kullanıcı baskı, büyük ekran ya da "yüksek çözünürlük" derse; 4k sadece nano_banana_2_1 ile ve kullanıcı açıkça 4k isterse.' },
                    yuksek_cozunurluk: { type: 'boolean', description: 'true: 2k üret (resolution "2k" ile aynı). Sadece kullanıcı baskı, büyük ekran ya da "yüksek çözünürlük" isterse.' },
                    style: { type: 'string', enum: IMAGE_MODELS.recraft_v4_1.styles, description: 'Sadece recraft_v4_1: standard, vector (logo/ikon/tipografi), utility, utility_vector.' },
                    reference_image: { type: 'string', description: 'İsteğe bağlı ek referans (stil ya da içerik için): önceki bir üretim (gen_…) ya da kullanıcının gönderdiği görselin yolu: Hermes’in mesajda verdiği yol, aynen (WhatsApp’tan gelen görsel: /opt/data/platforms/whatsapp_cloud/media/…; "[Image attached at: …]" ya da "image_url: …" içindeki yol). Logo için bunu değil logo alanını kullan.' },
                    ozet: ozetProp,
                    requested_by: requestedByProp,
                },
                required: ['prompt'],
                additionalProperties: false,
            },
            annotations: { title: 'Görsel üret (kredi harcar)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            handler: (args) => generateImage(args),
        },
        {
            name: 'edit_image',
            description:
                'Var olan bir görselde HEDEFLİ değişiklik yapar (gpt_image_2_6, görselden görsele): önceki bir üretim (generation_id) ya da kullanıcının WhatsApp’tan gönderdiği görsel (kaynak_gorsel). Sadece "başlığı değiştir", "rengi koyulaştır", "şunu ekle/çıkar" gibi istekler için; "yeni / farklı / daha modern / baştan / alternatif" için değil (onlar yeni generate_image). Talimatta neyin değişeceğini yaz (Türkçe ya da İngilizce); geri kalan korunur. Yeni bir üretimdir: kredi harcar (1k yaklaşık 1,5), aynı sınırlar ve onay geçerli. "ozet" alanını doldur. Başarısız olursa kendiliğinden tekrar deneme.',
            inputSchema: {
                type: 'object',
                properties: {
                    generation_id: { type: 'string', description: 'Düzenlenecek önceki üretim (gen_…).' },
                    kaynak_gorsel: { type: 'string', description: 'generation_id yerine: kullanıcının gönderdiği görselin yolu: Hermes’in mesajda verdiği yol, aynen (WhatsApp’tan gelen görsel: /opt/data/platforms/whatsapp_cloud/media/…; "[Image attached at: …]" ya da "image_url: …" içindeki yol).' },
                    talimat: { type: 'string', maxLength: 2000, description: 'Ne değişecek (ör. "başlığı \'Yapay Zeka Atölyesi\' yap", "arka planı lacivert yap", "sağ alttaki logoyu düzelt"). Yeni yazı varsa aynen ve Türkçe karakterleriyle yaz.' },
                    logo: { type: 'boolean', description: 'Gerçek kulüp logosu referans olarak verilsin mi. Varsayılan: kaynak üretimde logo varsa true. Logo düzeltilecekse true.' },
                    logo_konum: { type: 'string', enum: LOGO_CORNERS, description: 'İsteğe bağlı köşe (varsayılan kaynak üretimdeki; o da yoksa logo yerinde kalır ya da model seçer).' },
                    logo_zemin: { type: 'string', enum: ['koyu', 'acik'], description: 'Logo köşesinin zemini (varsayılan koyu).' },
                    platform: { type: 'string', enum: platformKeys, description: 'İsteğe bağlı: başka orana çevirmek için. Verilmezse kaynağın oranı korunur.' },
                    yuksek_cozunurluk: { type: 'boolean', description: 'true: 2k. Sadece kullanıcı açıkça isterse.' },
                    ozet: ozetProp,
                    requested_by: requestedByProp,
                },
                required: ['talimat'],
                additionalProperties: false,
            },
            annotations: { title: 'Görseli düzenle (kredi harcar)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
            handler: (args) => editImage(args),
        },
        {
            name: 'add_logo',
            description:
                'Önceki bir görsele gerçek kulüp logosunu (PNG) birebir ekler; model çizmez, kredi harcamaz. Logo zeminin açık/koyu olmasına göre otomatik seçilir, görsel genişliğinin ~%12’si kadar. Modelin çizdiği logo bozuk çıktıysa ("logoyu düzelt") kullan. Asıl görsel değişmez; logolu hali ayrı saklanır ve önizleme, asıl dosya ve TryPost’a ekleme onu kullanır.',
            inputSchema: {
                type: 'object',
                properties: {
                    generation_id: generationIdProp,
                    konum: { type: 'string', enum: LOGO_CORNERS, description: 'Köşe: alt-sag (varsayılan ya da üretimdeki köşe), alt-sol, ust-sag, ust-sol.' },
                    ozet: ozetProp,
                },
                required: ['generation_id'],
                additionalProperties: false,
            },
            annotations: { title: 'Logo ekle (kredi harcamaz)', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            handler: (args) => addLogo(args),
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
                    ozet: ozetProp,
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
                    logosuz: logosuzProp,
                    ozet: ozetProp,
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
        return `${text.trim()}\n\n---\nGeçitteki ayarlar: platform oranları ${ratios}. generate_image: baslik/alt_metin görsele aynen yazılır; logo (varsayılan true) gerçek logo dosyasını referans verir; yerini model kompozisyona göre seçer, logo_konum (${LOGO_CORNERS.join(', ')}) sadece köşe istenirse. secenek: 2 farklı stilde iki ayrı görsel üretir (iki kat kredi). Logo bozuk çıkarsa add_logo (kredi harcamaz). Hedefli değişiklik için edit_image; yeni fikir için yeni generate_image.`;
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
        // Hermes shows this answer itself, so the background "ready" message is no longer needed.
        if (row.status === 'completed' || row.status === 'failed') store.markNotify(row.id, 'waiting', 'shown');
        if (row.status === 'completed') return describeResult(row, usageNumbers(), ['(Bu sonuç daha önce başlatılmış üretime ait; yeni kredi harcanmadı.)']);
        if (row.status === 'failed') return failedMessage(row);
        if (row.status === 'unknown' && !row.job_id) return MESSAGES.unmatched(row.id);
        if (row.status === 'unknown') return 'Bu üretimin sonucu bilinmiyor (Higgsfield cevap vermedi). Tekrar denemiyorum.';
        if (row.status === 'late') return MESSAGES.late(row.id);
        return MESSAGES.notReady;
    }

    function originalFile({ generation_id: id, logosuz }) {
        const row = requireGeneration(id);
        if (row.status !== 'completed' || !row.file) refuse(MESSAGES.notReady);
        const shown = deliverable(row, { original: logosuz === true });
        const path = exposeToHermes(row, shown.final ? '-final' : '-original', shown.file);
        return [
            'Asıl dosyayı belge olarak göndermek için cevabına ayrı satırlarda aynen şunları yaz:',
            `MEDIA:${path}`,
            '[[as_document]]',
            `(${shown.mime}, ${(shown.bytes / MB).toFixed(1)} MB${shown.final ? ', gerçek kulüp logosu eklenmiş hali; logosuz hali için logosuz: true' : ''}; belge olarak gönderilen dosya WhatsApp'ta sıkıştırılmaz.)`,
        ].join('\n');
    }

    async function generateImage(args) {
        const model = args.model ?? DEFAULT_IMAGE_MODEL;
        const attempt = { tool: 'generate_image', kind: 'image', model, requestedBy: personBucket(args.requested_by, settings.people), summary: summaryOf(args.ozet) };
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
        // 1k unless the request explicitly asks for more (yuksek_cozunurluk → 2k; 4k only by name, nano_banana_2_1 only).
        const resolution = args.resolution ?? (args.yuksek_cozunurluk === true ? '2k' : DEFAULT_IMAGE_RESOLUTION);
        if (!spec.resolutions.includes(resolution)) refuseAttempt(attempt, `${model} için çözünürlük ${spec.resolutions.join(' / ')} olabilir.`);
        if (args.reference_image && !spec.references) refuseAttempt(attempt, `${model} referans görsel almıyor; referans için gpt_image_2_6 ya da nano_banana_2_1 kullan.`);
        const baslik = posterText(args.baslik);
        const altMetin = posterText(args.alt_metin);
        if (baslik.length > BASLIK_MAX) refuseAttempt(attempt, `Başlık çok uzun (en fazla ${BASLIK_MAX} karakter); afişte kısa başlık daha iyi okunur.`);
        if (altMetin.length > ALT_METIN_MAX) refuseAttempt(attempt, `Alt metin çok uzun (en fazla ${ALT_METIN_MAX} karakter).`);
        if (altMetin && !baslik) refuseAttempt(attempt, 'alt_metin için baslik da ver.');
        // The corner only when the user or Hermes chose one; otherwise the model places the logo.
        const corner = args.logo_konum ?? null;
        if (corner !== null && !LOGO_CORNERS.includes(corner)) refuseAttempt(attempt, `logo_konum ${LOGO_CORNERS.join(', ')} olabilir.`);
        // The real logo goes to the model as a reference: only models that take references (not Recraft).
        const logo = args.logo !== false && spec.references;
        if (args.logo === true && !spec.references) refuseAttempt(attempt, `${model} referans görsel almadığı için logoyu veremiyorum; gpt_image_2_6 kullan ya da sonra add_logo ile ekle.`);
        const logoCorner = logo ? corner : null;
        // secenek: 2 → two independent generations of the brief, each with its own style direction.
        const secenek = args.secenek ?? 1;
        if (secenek !== 1 && secenek !== 2) refuseAttempt(attempt, MESSAGES.variants);
        let styles = [null];
        if (secenek === 2) {
            const given = Array.isArray(args.stiller) ? args.stiller.map((item) => posterText(item).slice(0, 200)).filter(Boolean) : [];
            styles = given.length >= 2 && given[0] !== given[1] ? given.slice(0, 2) : pickStyles(given[0]);
        }

        // Built here from the allowlist: nothing else Hermes sends reaches Higgsfield.
        const colors = baslik || logo ? settings.brandColors : null;
        const fullPrompt = (style) => buildImagePrompt({ prompt, baslik: baslik || null, altMetin: altMetin || null, logo, logoCorner, style, colors });
        const params = { model, prompt: fullPrompt(styles[0]), aspect_ratio: aspect, batch_size: 1, count: 1, use_unlim: settings.allowUnlim };
        if (settings.allowFreeGens) params.use_free_gens = true;
        if (model === 'gpt_image_2_6') Object.assign(params, { quality: 'high', resolution, output_format: settings.imageFormat });
        if (model === 'nano_banana_2_1') params.resolution = resolution;
        if (model === 'recraft_v4_1') {
            const style = args.style ?? 'standard';
            if (!spec.styles.includes(style)) refuseAttempt(attempt, `recraft_v4_1 stili ${spec.styles.join(', ')} olabilir.`);
            Object.assign(params, { resolution, model_type: style, colors: settings.brandColors.slice(0, 10) });
        }
        const references = [];
        if (args.reference_image) references.push(args.reference_image);
        if (logo) references.push(logoVariant(args.logo_zemin));
        const record = { ...(baslik ? { poster: { baslik, ...(altMetin ? { alt_metin: altMetin } : {}) } } : {}), ...(logo ? { logo: true } : {}) };
        if (secenek === 1) return generate({ ...attempt, params, references, logoCorner, record });
        const variants = styles.map((style) => ({ params: { ...params, prompt: fullPrompt(style) }, label: style, record: { stil: style } }));
        return generate({ ...attempt, variants, references, logoCorner, record });
    }

    /** Two different style directions (the first one given, if any, kept). */
    function pickStyles(first = null) {
        const pool = STYLE_DIRECTIONS.filter((style) => style !== first);
        const a = first ?? pool.splice(randomBytes(1)[0] % pool.length, 1)[0];
        const b = pool[randomBytes(1)[0] % pool.length];
        return [a, b];
    }

    /** The logo file for the background of its corner: logo-dark.png (light lettering) on dark, logo.png on light. */
    const logoVariant = (zemin) => (zemin === 'acik' ? 'logo' : 'logo-dark');

    async function editImage(args) {
        const model = EDIT_MODEL;
        const spec = IMAGE_MODELS[model];
        const attempt = { tool: 'edit_image', higgsfieldTool: 'generate_image', kind: 'image', model, requestedBy: personBucket(args.requested_by, settings.people), summary: summaryOf(args.ozet) };
        if (!settings.imageModels.includes(model)) refuseAttempt(attempt, MESSAGES.unknownModel(settings.imageModels.join(', ')));
        const talimat = String(args.talimat ?? '').normalize('NFC').trim();
        if (!talimat) refuseAttempt(attempt, 'Düzenleme talimatı boş; neyin değişeceğini yaz.');
        if (talimat.length > 2000) refuseAttempt(attempt, 'Talimat çok uzun (en fazla 2000 karakter).');
        if (Boolean(args.generation_id) === Boolean(args.kaynak_gorsel)) refuseAttempt(attempt, MESSAGES.editSource);

        let source;
        let aspect = null;
        let sourceCorner = null;
        let sourceLogo = false;
        if (args.generation_id) {
            const row = store.get(String(args.generation_id));
            if (!row || row.kind !== 'image' || row.status !== 'completed' || !row.job_id) refuseAttempt(attempt, MESSAGES.editSource);
            source = row.id;
            aspect = row.params ? JSON.parse(row.params).aspect_ratio ?? null : null;
            if (!aspect && row.width) aspect = nearestAspect(row.width, row.height, spec.aspectRatios);
            sourceCorner = row.logo_corner;
            sourceLogo = Boolean(row.logo_corner) || (row.params ? JSON.parse(row.params).logo === true : false);
        } else {
            const value = String(args.kaynak_gorsel).trim();
            if (!value.startsWith('/')) refuseAttempt(attempt, MESSAGES.editSource);
            try {
                source = userImagePath(value);
            } catch (error) {
                if (error instanceof Refusal) refuseAttempt(attempt, error.userMessage);
                throw error;
            }
            let size = null;
            try {
                size = imageSize(readFileSync(source));
            } catch {
                size = null;
            }
            if (size) aspect = nearestAspect(size.width, size.height, spec.aspectRatios);
        }
        if (args.platform) {
            aspect = settings.platformAspectRatios[args.platform];
            if (!aspect) refuseAttempt(attempt, `Bilinmeyen platform. Seçenekler: ${platformKeys.join(', ')}.`);
        }
        aspect ??= '1:1';
        if (!spec.aspectRatios.includes(aspect)) aspect = nearestAspect(...aspect.split(':').map(Number), spec.aspectRatios);
        const corner = args.logo_konum ?? sourceCorner ?? null;
        if (corner !== null && !LOGO_CORNERS.includes(corner)) refuseAttempt(attempt, `logo_konum ${LOGO_CORNERS.join(', ')} olabilir.`);
        const logo = args.logo ?? sourceLogo;
        const logoCorner = logo ? corner : null;
        const resolution = args.yuksek_cozunurluk === true ? '2k' : DEFAULT_IMAGE_RESOLUTION;

        const params = { model, prompt: buildEditPrompt({ talimat, logo, logoCorner }), aspect_ratio: aspect, batch_size: 1, count: 1, use_unlim: settings.allowUnlim, quality: 'high', resolution, output_format: settings.imageFormat };
        if (settings.allowFreeGens) params.use_free_gens = true;
        const references = [source];
        if (logo) references.push(logoVariant(args.logo_zemin));
        const record = { edit: { source: args.generation_id ? source : 'kullanici-gorseli', talimat: talimat.slice(0, 300) }, ...(logo ? { logo: true } : {}) };
        return generate({ ...attempt, params, references, logoCorner, record });
    }

    // Per generation: one add_logo at a time.
    const composing = new Set();

    async function addLogo({ generation_id: id, konum }) {
        const row = requireGeneration(id);
        if (row.kind !== 'image') refuse(MESSAGES.notImage);
        if (row.status !== 'completed' || !row.file) refuse(MESSAGES.notReady);
        if (!compositor) refuse(MESSAGES.noCompositor);
        const corner = konum ?? row.logo_corner ?? DEFAULT_LOGO_CORNER;
        if (!LOGO_CORNERS.includes(corner)) refuse(`konum ${LOGO_CORNERS.join(', ')} olabilir.`);
        const original = readFileSync(row.file);
        if (createHash('sha256').update(original).digest('hex') !== row.sha256) refuse(MESSAGES.integrity);
        const size = row.width && row.height ? { width: row.width, height: row.height } : imageSize(original);
        if (!size) refuse(MESSAGES.logoFailed);
        if (composing.has(row.id)) refuse(MESSAGES.busy);
        composing.add(row.id);
        let made;
        try {
            // Always from the untouched original, so a second add_logo (another corner) never stacks logos.
            made = await compositor.apply({ input: row.file, output: join(settings.originalsDir, `${row.id}-final.png`), width: size.width, height: size.height, corner });
        } catch (error) {
            log('warn', 'studio add_logo failed', row.id, error.message);
            refuse(MESSAGES.logoFailed);
        } finally {
            composing.delete(row.id);
        }
        store.update(row.id, { logoCorner: corner, finalFile: made.file, finalBytes: made.bytes, finalSha256: made.sha256, finalVariant: made.variant });
        log('info', 'studio logo composited', row.id, corner, made.variant);
        const updated = store.get(row.id);
        const lines = [`Gerçek kulüp logosu eklendi (${CORNER_NAMES[corner]} köşe, ${made.variant === 'logo-dark' ? 'koyu zemin için açık renkli' : 'açık zemin için lacivert'} logo). Kredi harcanmadı. generation_id: ${row.id}`];
        if (made.bytes <= settings.whatsappPreviewMaxMb * MB) lines.push('Kullanıcıya göstermek için cevabına ayrı bir satırda aynen şunu yaz:', `MEDIA:${exposeToHermes(updated, '-final-preview', made.file)}`);
        lines.push('Bundan sonra önizleme, get_original_file ve attach_to_trypost logolu hali kullanır; logosuz asıl hali saklı (logosuz: true).');
        return lines.join('\n');
    }

    async function generateAudio(args) {
        const kind = args.kind;
        if (kind === 'speech') {
            const attempt = { tool: 'generate_audio', kind: 'speech', model: SPEECH_MODEL, requestedBy: personBucket(args.requested_by, settings.people), summary: summaryOf(args.ozet) };
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
            const attempt = { tool: 'generate_audio', kind: 'music', model: MUSIC_MODEL, requestedBy: personBucket(args.requested_by, settings.people), summary: summaryOf(args.ozet) };
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

    // ozet is display-only (the approval card); it is accepted and ignored here.
    async function attachToTryPost({ generation_id: id, post_id: postId, social_account_id: accountId, content, logosuz }) {
        const row = requireGeneration(id);
        if (row.kind !== 'image') {
            store.addAttachment({ generationId: row.id, project: settings.project ?? '-', status: 'refused', reason: 'audio' });
            refuse(MESSAGES.audioAttach);
        }
        if (!trypost || !settings.project) refuse(MESSAGES.noProject);
        if (row.status !== 'completed' || !row.file) refuse(MESSAGES.notReady);
        // The final (real logo composited by add_logo) when there is one, else the original; byte for byte.
        const shown = deliverable(row, { original: logosuz === true });
        const bytes = readFileSync(shown.file);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== shown.sha256) refuse(MESSAGES.integrity);
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

        const filename = `${row.id}${shown.final ? '-logo' : ''}${extname(shown.file)}`;
        let upload;
        try {
            upload = await trypost.uploadMedia({ file: new Blob([bytes], { type: shown.mime }), filename, mimeType: shown.mime });
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
        const note = shown.mime === 'image/png' ? ' Not: TryPost PNG dosyaları kendi tarafında JPEG’e (kalite 100, aynı boyut) çeviriyor.' : '';
        return `Görselin ${shown.final ? 'logolu ' : ''}asıl dosyası (${shown.mime}, ${(bytes.length / MB).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…) WhatsApp’tan geçmeden TryPost’a yüklendi ve ${what}.${note}`;
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
            await notifyFinished();
        },
        approvalHint,
    };
}
