import { TEMPLATES } from './templates.js';

/**
 * Checks for everything a render job carries. Used twice: by the studio before a job is sent (with
 * Hermes' asset references: logo, gen_…, a picture path) and by the render service before anything
 * is drawn (with the job's own asset ids). A check fails with a RenderInputError whose message is
 * short Turkish text Hermes can pass on.
 *
 * Free compositions are a JSON scene description, not HTML: no markup, CSS or script from the caller
 * ever reaches the browser (html.js builds the page from these checked values). On top of the strict
 * shape (allowlisted keys, types, ranges, colour patterns), every string is refused if it looks like a
 * URL or code (scheme://, url(, @import, javascript:, data:, tags, fetch/XMLHttpRequest/WebSocket…),
 * so a composition cannot even name an outside resource.
 */

export class RenderInputError extends Error {
    constructor(message) {
        super(message);
        this.userMessage = message;
        this.status = 400;
    }
}
const fail = (message) => {
    throw new RenderInputError(message);
};

/** Output frames per platform at full quality (shorter side 1080). */
export const PLATFORMS = {
    reels: { label: 'Instagram Reels', ratio: '9:16', width: 1080, height: 1920 },
    story: { label: 'Hikâye', ratio: '9:16', width: 1080, height: 1920 },
    tiktok: { label: 'TikTok', ratio: '9:16', width: 1080, height: 1920 },
    shorts: { label: 'YouTube Shorts', ratio: '9:16', width: 1080, height: 1920 },
    instagram: { label: 'Instagram gönderi', ratio: '4:5', width: 1080, height: 1350 },
    kare: { label: 'Kare', ratio: '1:1', width: 1080, height: 1080 },
    linkedin: { label: 'LinkedIn', ratio: '1:1', width: 1080, height: 1080 },
    x: { label: 'X', ratio: '16:9', width: 1920, height: 1080 },
    youtube: { label: 'YouTube', ratio: '16:9', width: 1920, height: 1080 },
};
export const DEFAULT_PLATFORM = 'reels';

export const LIMITS = {
    minSeconds: 3,
    maxSeconds: 60,
    maxPixels: 1080 * 1920,
    fps: [24, 25, 30],
    compositionBytes: 32 * 1024,
    scenes: 12,
    elementsPerScene: 12,
    elements: 80,
    textChars: 300,
    captions: 200,
    assets: 16,
    assetBytes: 15 * 1024 * 1024,
    totalAssetBytes: 50 * 1024 * 1024,
};

export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg']);

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Strings that name an outside resource or look like code. Checked on every string of a job. */
const FORBIDDEN = [
    /[a-z][a-z0-9+.-]*:\/\//i,
    /(?:^|[\s"'(=])\/\/[^\s/]/,
    /\burl\s*\(/i,
    /@import/i,
    /\bjavascript\s*:/i,
    /\bvbscript\s*:/i,
    /\bdata\s*:\s*[a-z]+\//i,
    /\bblob\s*:/i,
    /<\s*\/?\s*[a-z!?]/i,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon|eval|Function|setTimeout|setInterval)\s*\(/,
    /\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource|Worker|SharedWorker|Function)\b/,
    /\bimport\s*\(/,
    /\bon[a-z]+\s*=/i,
    /\bexpression\s*\(/i,
];

/** The string, trimmed, if it is allowed in a job; else a refusal naming the field. */
export function safeString(value, field, max) {
    if (typeof value !== 'string') fail(`${field} metin olmalı.`);
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
    if (max !== undefined && text.length > max) fail(`${field} en fazla ${max} karakter olabilir (${text.length}).`);
    for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) fail(`${field} adres ya da kod içeremez (ör. "https://", "url(", "<script", "fetch(" yok). Bağlantıyı "marmaraai.com/kayit" gibi şemasız yaz.`);
    }
    return text;
}

const number = (value, field, min, max) => {
    const parsed = typeof value === 'number' ? value : NaN;
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) fail(`${field} ${min} ile ${max} arasında bir sayı olmalı.`);
    return parsed;
};
const color = (value, field) => {
    if (typeof value !== 'string' || !COLOR.test(value)) fail(`${field} #rrggbb biçiminde bir renk olmalı.`);
    return value.toLowerCase();
};
const oneOf = (value, field, allowed) => {
    if (!allowed.includes(value)) fail(`${field} şunlardan biri olmalı: ${allowed.join(', ')}.`);
    return value;
};
const plainObject = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} bir nesne olmalı.`);
    return value;
};
function onlyKeys(value, field, allowed) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field} içinde bilinmeyen alan: ${String(key).slice(0, 30)}. İzinli alanlar: ${allowed.join(', ')}.`);
}

export const ANIMATIONS = ['none', 'fade', 'fade-up', 'fade-down', 'slide-left', 'slide-right', 'pop', 'zoom-in', 'wipe'];
export const TRANSITIONS = ['fade', 'slide-up', 'zoom', 'none'];
const ELEMENT_KEYS = {
    text: ['type', 'text', 'x', 'y', 'w', 'size', 'weight', 'color', 'align', 'font', 'uppercase', 'italic', 'shadow', 'background', 'opacity', 'animation', 'delay'],
    image: ['type', 'asset', 'x', 'y', 'w', 'h', 'fit', 'shape', 'radius', 'border', 'shadow', 'kenburns', 'opacity', 'animation', 'delay'],
    shape: ['type', 'shape', 'x', 'y', 'w', 'h', 'color', 'gradient', 'angle', 'radius', 'opacity', 'animation', 'delay'],
    logo: ['type', 'variant', 'x', 'y', 'w', 'opacity', 'animation', 'delay'],
};

/**
 * `asset(ref, kind, field)` checks an asset reference and returns the value to keep (the studio maps
 * Hermes' references; the render service accepts only its job's ids). kind: 'image' | 'audio'.
 */
function background(value, field, asset) {
    const bg = plainObject(value, field);
    onlyKeys(bg, field, ['color', 'gradient', 'angle', 'image', 'dim', 'kenburns']);
    const out = {};
    if (bg.color !== undefined) out.color = color(bg.color, `${field}.color`);
    if (bg.gradient !== undefined) {
        if (!Array.isArray(bg.gradient) || bg.gradient.length !== 2) fail(`${field}.gradient iki renkli bir liste olmalı.`);
        out.gradient = bg.gradient.map((item, index) => color(item, `${field}.gradient[${index}]`));
    }
    if (bg.angle !== undefined) out.angle = number(bg.angle, `${field}.angle`, 0, 360);
    if (bg.image !== undefined) out.image = asset(bg.image, 'image', `${field}.image`);
    if (bg.dim !== undefined) out.dim = number(bg.dim, `${field}.dim`, 0, 0.9);
    if (bg.kenburns !== undefined) {
        if (bg.kenburns !== true && bg.kenburns !== false && bg.kenburns !== 'out') fail(`${field}.kenburns true, false ya da "out" olmalı.`);
        out.kenburns = bg.kenburns;
    }
    return out;
}

function element(value, field, asset) {
    const el = plainObject(value, field);
    const type = oneOf(el.type, `${field}.type`, Object.keys(ELEMENT_KEYS));
    onlyKeys(el, field, ELEMENT_KEYS[type]);
    const out = { type };
    const box = (key, min, max) => {
        if (el[key] !== undefined) out[key] = number(el[key], `${field}.${key}`, min, max);
    };
    box('x', -50, 150);
    box('y', -50, 150);
    box('w', 0.1, 200);
    box('h', 0.1, 200);
    box('opacity', 0, 1);
    box('delay', 0, 60);
    if (el.animation !== undefined) out.animation = oneOf(el.animation, `${field}.animation`, ANIMATIONS);
    if (type === 'text') {
        out.text = safeString(el.text, `${field}.text`, LIMITS.textChars);
        if (!out.text) fail(`${field}.text boş olamaz.`);
        box('size', 12, 300);
        if (el.weight !== undefined) out.weight = oneOf(el.weight, `${field}.weight`, [300, 400, 500, 600, 700, 800, 900]);
        if (el.color !== undefined) out.color = color(el.color, `${field}.color`);
        if (el.background !== undefined) out.background = color(el.background, `${field}.background`);
        if (el.align !== undefined) out.align = oneOf(el.align, `${field}.align`, ['left', 'center', 'right']);
        if (el.font !== undefined) out.font = oneOf(el.font, `${field}.font`, ['sans', 'serif']);
        for (const flag of ['uppercase', 'italic', 'shadow']) if (el[flag] !== undefined) out[flag] = el[flag] === true;
    } else if (type === 'image') {
        out.asset = asset(el.asset, 'image', `${field}.asset`);
        if (el.fit !== undefined) out.fit = oneOf(el.fit, `${field}.fit`, ['cover', 'contain']);
        if (el.shape !== undefined) out.shape = oneOf(el.shape, `${field}.shape`, ['rect', 'circle']);
        box('radius', 0, 500);
        if (el.border !== undefined) out.border = color(el.border, `${field}.border`);
        for (const flag of ['shadow', 'kenburns']) if (el[flag] !== undefined) out[flag] = el[flag] === true;
    } else if (type === 'shape') {
        if (el.shape !== undefined) out.shape = oneOf(el.shape, `${field}.shape`, ['rect', 'circle']);
        if (el.color !== undefined) out.color = color(el.color, `${field}.color`);
        if (el.gradient !== undefined) {
            if (!Array.isArray(el.gradient) || el.gradient.length !== 2) fail(`${field}.gradient iki renkli bir liste olmalı.`);
            out.gradient = el.gradient.map((item, index) => color(item, `${field}.gradient[${index}]`));
        }
        box('angle', 0, 360);
        box('radius', 0, 500);
    } else {
        out.variant = el.variant === undefined ? 'logo-dark' : oneOf(el.variant, `${field}.variant`, ['logo', 'logo-dark']);
    }
    return out;
}

/**
 * A free composition: { background?, scenes: [{ duration, background?, transition?, elements? }] }.
 * Scene durations are relative: they are scaled to `seconds` and laid end to end. Returns the
 * checked composition with each scene's `start` and `duration` in seconds.
 */
export function validateComposition(value, { seconds, asset }) {
    const raw = plainObject(value, 'kompozisyon');
    let size;
    try {
        size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    } catch {
        fail('kompozisyon okunamadı.');
    }
    if (size > LIMITS.compositionBytes) fail(`kompozisyon çok büyük (${Math.round(size / 1024)} KB; en fazla ${LIMITS.compositionBytes / 1024} KB).`);
    onlyKeys(raw, 'kompozisyon', ['background', 'scenes']);
    const out = {};
    if (raw.background !== undefined) out.background = background(raw.background, 'kompozisyon.background', asset);
    if (!Array.isArray(raw.scenes) || !raw.scenes.length) fail('kompozisyon.scenes en az bir sahne içermeli.');
    if (raw.scenes.length > LIMITS.scenes) fail(`En fazla ${LIMITS.scenes} sahne olabilir.`);
    let elements = 0;
    const scenes = raw.scenes.map((sceneValue, index) => {
        const field = `scenes[${index}]`;
        const scene = plainObject(sceneValue, field);
        onlyKeys(scene, field, ['duration', 'background', 'transition', 'elements']);
        const checked = { duration: number(scene.duration, `${field}.duration`, 0.5, LIMITS.maxSeconds) };
        if (scene.background !== undefined) checked.background = background(scene.background, `${field}.background`, asset);
        if (scene.transition !== undefined) checked.transition = oneOf(scene.transition, `${field}.transition`, TRANSITIONS);
        const list = scene.elements ?? [];
        if (!Array.isArray(list)) fail(`${field}.elements bir liste olmalı.`);
        if (list.length > LIMITS.elementsPerScene) fail(`${field}: bir sahnede en fazla ${LIMITS.elementsPerScene} öğe olabilir.`);
        elements += list.length;
        checked.elements = list.map((item, at) => element(item, `${field}.elements[${at}]`, asset));
        return checked;
    });
    if (elements > LIMITS.elements) fail(`Toplam en fazla ${LIMITS.elements} öğe olabilir.`);
    const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
    const factor = seconds / total;
    let start = 0;
    for (const scene of scenes) {
        scene.duration = Math.round(scene.duration * factor * 1000) / 1000;
        scene.start = Math.round(start * 1000) / 1000;
        start += scene.duration;
    }
    out.scenes = scenes;
    return out;
}

/** A template call's parameters, checked against TEMPLATES[name].params. */
export function validateTemplate(name, value, { asset }) {
    const template = TEMPLATES[name];
    if (!template) fail(`Şablon şunlardan biri olmalı: ${Object.keys(TEMPLATES).join(', ')}.`);
    const params = value === undefined ? {} : plainObject(value, 'parametreler');
    onlyKeys(params, `${name} parametreleri`, Object.keys(template.params));
    const out = {};
    for (const [key, rule] of Object.entries(template.params)) {
        const given = params[key];
        if (given === undefined || given === null || given === '') {
            if (rule.required) fail(`${name} şablonu için "${key}" gerekli: ${rule.description}`);
            continue;
        }
        const field = `parametreler.${key}`;
        if (rule.type === 'string') {
            out[key] = safeString(given, field, rule.max);
        } else if (rule.type === 'asset') {
            out[key] = asset(given, rule.kind, field);
        } else if (rule.type === 'assets') {
            if (!Array.isArray(given) || given.length < (rule.min ?? 0) || given.length > rule.max) fail(`${field} ${rule.min ?? 0}-${rule.max} öğelik bir liste olmalı.`);
            out[key] = given.map((item, index) => asset(item, rule.kind, `${field}[${index}]`));
        } else if (rule.type === 'strings') {
            if (!Array.isArray(given) || given.length > rule.max) fail(`${field} en fazla ${rule.max} öğelik bir liste olmalı.`);
            out[key] = given.map((item, index) => (item === null || item === '' ? '' : safeString(item, `${field}[${index}]`, rule.itemMax)));
        }
    }
    return out;
}

/** Output size for a platform at the configured short side (1080 or 720), even numbers. */
export function outputSize(platform, shortSide = 1080) {
    const base = PLATFORMS[platform] ?? fail(`platform şunlardan biri olmalı: ${Object.keys(PLATFORMS).join(', ')}.`);
    const factor = Math.min(1, shortSide / Math.min(base.width, base.height));
    const even = (value) => Math.max(2, Math.round((value * factor) / 2) * 2);
    return { width: even(base.width), height: even(base.height) };
}

/** Clamp a requested length in seconds to the allowed range. */
export function checkSeconds(value, max = LIMITS.maxSeconds) {
    const seconds = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(seconds)) fail('sure saniye cinsinden bir sayı olmalı.');
    if (seconds < LIMITS.minSeconds || seconds > max) fail(`Video ${LIMITS.minSeconds}-${max} saniye olabilir.`);
    return Math.round(seconds * 10) / 10;
}

/**
 * The whole job as the render service receives it (assets already decoded elsewhere):
 * { size: { width, height, fps }, seconds, template?, params?, composition?, audio?: { music, voiceover,
 *   music_volume, subtitles } }. `assetKinds` maps job asset ids to 'image' | 'audio'.
 */
export function validateJob(job, { assetKinds }) {
    const raw = plainObject(job, 'iş');
    onlyKeys(raw, 'iş', ['id', 'size', 'seconds', 'template', 'params', 'composition', 'audio']);
    const size = plainObject(raw.size, 'size');
    onlyKeys(size, 'size', ['width', 'height', 'fps']);
    const width = number(size.width, 'size.width', 16, 1920);
    const height = number(size.height, 'size.height', 16, 1920);
    if (width % 2 || height % 2 || !Number.isInteger(width) || !Number.isInteger(height)) fail('size.width ve size.height çift tam sayı olmalı.');
    if (width * height > LIMITS.maxPixels) fail('Çözünürlük en fazla 1080x1920 olabilir.');
    const fps = oneOf(size.fps ?? 30, 'size.fps', LIMITS.fps);
    const seconds = checkSeconds(raw.seconds);
    const asset = (ref, kind, field) => {
        if (typeof ref !== 'string' || assetKinds[ref] === undefined) fail(`${field}: bu işte "${String(ref).slice(0, 40)}" diye bir dosya yok.`);
        if (assetKinds[ref] !== kind) fail(`${field}: ${kind === 'image' ? 'görsel' : 'ses'} olmalı.`);
        return ref;
    };
    const out = { id: typeof raw.id === 'string' ? raw.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : 'job', size: { width, height, fps }, seconds };
    if ((raw.template === undefined) === (raw.composition === undefined)) fail('Ya bir şablon ya da bir kompozisyon verilmeli (ikisi birden değil).');
    if (raw.template !== undefined) {
        out.template = raw.template;
        out.params = validateTemplate(raw.template, raw.params, { asset });
    } else {
        if (raw.params !== undefined) fail('parametreler sadece şablonla verilir.');
        out.composition = validateComposition(raw.composition, { seconds, asset });
    }
    if (raw.audio !== undefined) {
        const audio = plainObject(raw.audio, 'audio');
        onlyKeys(audio, 'audio', ['music', 'voiceover', 'music_volume', 'subtitles']);
        out.audio = {};
        if (audio.music !== undefined) out.audio.music = asset(audio.music, 'audio', 'audio.music');
        if (audio.voiceover !== undefined) out.audio.voiceover = asset(audio.voiceover, 'audio', 'audio.voiceover');
        if (audio.music_volume !== undefined) out.audio.musicVolume = number(audio.music_volume, 'audio.music_volume', 0, 1);
        out.audio.subtitles = audio.subtitles === true;
    }
    return out;
}

/**
 * Re-checks a built composition (templates go through the same gate as free ones): every scene
 * inside the video, every asset known. Returns it unchanged.
 */
export function checkBuilt(composition, { seconds, assetKinds }) {
    const asset = (ref, kind, field) => {
        if (assetKinds[ref] !== kind) fail(`${field}: dosya bulunamadı.`);
        return ref;
    };
    const scenes = composition.scenes.map((scene) => ({ duration: scene.duration, background: scene.background, transition: scene.transition, elements: scene.elements }));
    for (const scene of scenes) for (const key of Object.keys(scene)) if (scene[key] === undefined) delete scene[key];
    validateComposition({ background: composition.background, scenes }, { seconds, asset });
    return composition;
}
