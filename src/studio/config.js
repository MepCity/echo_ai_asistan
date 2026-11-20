import { join } from 'node:path';

/**
 * Settings of the studio gateway (src/studio): the `studio` section of Echo's
 * config.json, every key optional. Secrets never live here: the bearer secret
 * Hermes sends is ECHO_STUDIO_TOKEN and an optional Higgsfield key is
 * HIGGSFIELD_API_KEY, both from the environment (/opt/echo/.env).
 *
 * {
 *   "studio": {
 *     "project": "marmara",            // TryPost project generated images may be attached to (default: the media bridge's)
 *     "port": 8091,
 *     "limits": { "maxCreditsPerRequest": 10, "cooldownSec": 60, "dailyCredits": 40, "dailyImages": 15,
 *                 "dailyMusic": 5, "dailySpeech": 20, "monthlyCredits": 400, "perPersonDailyCredits": 20 },
 *     "imageModels": ["gpt_image_2_6", "nano_banana_2_1", "recraft_v4_1"],   // may only narrow the built-in allowlist
 *     "imageFormat": "png",            // gpt_image_2_6 output_format: png | jpeg | webp
 *     "platformAspectRatios": { "instagram": "4:5", ... },
 *     "voices": { "kadin": { "id": "<voice id>", "label": "Kadın" }, ... }, "defaultVoice": "kadin",
 *     "allowUnlim": false, "allowFreeGens": false,
 *     "jobTimeoutSec": 180,            // how long one generate call waits for its job before answering "still preparing"
 *     "pendingStaleMin": 15,           // a job pending longer than this stops blocking: one last check, then 'late' (or 'unknown' without a job id)
 *     "lateMaxHours": 24,              // a 'late' job is polled this long, then marked 'unknown'
 *     "previewDir": "...", "hermesPreviewDir": "...", "referenceDirs": ["..."], "brandKitFile": "..."
 *   }
 * }
 *
 * Directory defaults come from STUDIO_PREVIEW_DIR, STUDIO_REFERENCE_DIRS (comma
 * separated) and STUDIO_BRAND_KIT (set by deploy/oracle/docker-compose.yml), so a
 * config.json written before the studio existed needs no edit.
 */

/** The only Higgsfield models the gateway ever sends. An allowlist: anything else is refused. */
export const IMAGE_MODELS = {
    gpt_image_2_6: {
        label: 'GPT Image 2.6 (genel amaçlı, yazı ve referans görselle iyi)',
        resolutions: ['2k'],
        aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '4:5', '5:4', '21:9'],
        references: true,
    },
    nano_banana_2_1: {
        label: 'Nano Banana 2.1 (fotogerçekçi, 4k çıkabilir)',
        resolutions: ['1k', '2k', '4k'],
        aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'],
        references: true,
    },
    recraft_v4_1: {
        label: 'Recraft V4.1 (vektör, tipografi, ikon tarzı; referans görsel almaz)',
        resolutions: ['1k', '2k'],
        aspectRatios: ['1:1', '3:4', '4:3', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16'],
        references: false,
        styles: ['standard', 'vector', 'utility', 'utility_vector'],
    },
};
export const DEFAULT_IMAGE_MODEL = 'gpt_image_2_6';
export const SPEECH_MODEL = 'elevenlabs_v4';
export const MUSIC_MODEL = 'elevenlabs_music_v2_5';

/** Higgsfield MCP tools the gateway may call. Generation is only ever generate_image / generate_audio. */
export const HIGGSFIELD_TOOLS = new Set([
    'estimate_image_cost',
    'estimate_audio_cost',
    'generate_image',
    'generate_audio',
    'jobs_wait',
    'media_upload',
    'media_confirm',
    'media_import_url',
    'balance',
]);

export const LIMIT_DEFAULTS = {
    maxCreditsPerRequest: 10,
    cooldownSec: 60,
    dailyCredits: 40,
    dailyImages: 15,
    dailyMusic: 5,
    dailySpeech: 20,
    monthlyCredits: 400,
    perPersonDailyCredits: 20,
};

export const PLATFORM_ASPECT_RATIOS = {
    instagram: '4:5',
    instagram_kare: '1:1',
    story: '9:16',
    linkedin: '1:1',
    linkedin_dikey: '4:5',
    x: '16:9',
};

/** Preset voices of the Higgsfield account (list_voices). Which ones sound right in Turkish is for the user to try. */
export const VOICE_DEFAULTS = {
    kadin: { id: 'caeba733-3c17-43db-863e-69c7025512cd', label: 'Kadın (Naomi)' },
    erkek: { id: '30fc8796-ceb6-4a66-b3a7-4a145ef7f346', label: 'Erkek (Arthur)' },
    genc_kadin: { id: '6b3e3642-f7b7-4cb8-9688-51e233c4b92f', label: 'Genç kadın (Emily)' },
    genc_erkek: { id: '6b528d43-c056-4a2f-9d82-1591a7ba13b0', label: 'Genç erkek (John)' },
};

export const BRAND_COLORS = ['#3278f6', '#3cbdfa', '#0f1c47', '#1e6bf5', '#f1f5f9'];
export const LOGOS = {
    logo: 'https://sosyal.marmaraai.com/marmara/logo.svg',
    'logo-dark': 'https://sosyal.marmaraai.com/marmara/logo-dark.svg',
};

const number = (value, fallback, key, min = 0) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < min) throw new Error(`Config: studio.${key} must be a number >= ${min}`);
    return parsed;
};

/** `config` is Echo's normalized config (loadConfig); `raw` its `studio` section. */
export function normalizeStudio(raw, config, env = process.env) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const projectId = value.project ?? config.mediaBridge ?? null;
    const project = projectId ? config.projects.find((item) => item.id === projectId) : null;
    if (projectId && !project) throw new Error(`Config: studio.project ${projectId} is not a project`);
    if (project && project.type !== 'trypost') throw new Error('Config: studio.project must be a trypost project');

    const limits = {};
    for (const [key, fallback] of Object.entries(LIMIT_DEFAULTS)) limits[key] = number(value.limits?.[key], fallback, `limits.${key}`);

    let imageModels = Object.keys(IMAGE_MODELS);
    if (value.imageModels !== undefined) {
        if (!Array.isArray(value.imageModels)) throw new Error('Config: studio.imageModels must be a list');
        // Config may narrow the allowlist, never widen it.
        imageModels = value.imageModels.filter((id) => IMAGE_MODELS[id]);
        if (!imageModels.length) throw new Error('Config: studio.imageModels lists no allowed model');
    }

    const imageFormat = value.imageFormat ?? 'png';
    if (!['png', 'jpeg', 'webp'].includes(imageFormat)) throw new Error('Config: studio.imageFormat must be png, jpeg or webp');

    const voices = { ...VOICE_DEFAULTS, ...(value.voices ?? {}) };
    for (const [key, voice] of Object.entries(voices)) {
        if (!voice?.id) throw new Error(`Config: studio.voices.${key}.id is required`);
    }
    const defaultVoice = value.defaultVoice ?? 'kadin';
    if (!voices[defaultVoice]) throw new Error(`Config: studio.defaultVoice ${defaultVoice} is not in studio.voices`);

    const dataDir = join(config.dataDir, 'studio');
    const previewDir = value.previewDir ?? env.STUDIO_PREVIEW_DIR ?? join(dataDir, 'preview');
    const referenceDirs = value.referenceDirs ?? (env.STUDIO_REFERENCE_DIRS ? env.STUDIO_REFERENCE_DIRS.split(',').map((dir) => dir.trim()).filter(Boolean) : []);

    return {
        port: number(value.port ?? env.STUDIO_PORT, 8091, 'port', 1),
        mcpUrl: value.mcpUrl ?? 'https://mcp.higgsfield.ai/mcp',
        project: project?.id ?? null,
        timeZone: config.timeZone,
        limits,
        imageModels,
        imageFormat,
        platformAspectRatios: { ...PLATFORM_ASPECT_RATIOS, ...(value.platformAspectRatios ?? {}) },
        voices,
        defaultVoice,
        brandColors: value.brandColors ?? BRAND_COLORS,
        logos: { ...LOGOS, ...(value.logos ?? {}) },
        referenceHosts: value.referenceHosts ?? ['sosyal.marmaraai.com'],
        allowUnlim: value.allowUnlim === true,
        allowFreeGens: value.allowFreeGens === true,
        speechMaxChars: number(value.speechMaxChars, 1500, 'speechMaxChars', 1),
        musicMaxSec: Math.min(number(value.musicMaxSec, 60, 'musicMaxSec', 3), 60),
        jobTimeoutSec: number(value.jobTimeoutSec, 180, 'jobTimeoutSec', 1),
        // A sent job still pending after this long is marked 'unknown' (still counted) and stops blocking new ones.
        pendingStaleMin: number(value.pendingStaleMin, 15, 'pendingStaleMin', 1),
        // A job still running at the stale limit becomes 'late' (not blocking, still counted) and is polled this long, then 'unknown'.
        lateMaxHours: number(value.lateMaxHours, 24, 'lateMaxHours', 1),
        waitSliceSec: Math.min(number(value.waitSliceSec, 10, 'waitSliceSec', 0), 15),
        maxDownloadMb: number(value.maxDownloadMb, 50, 'maxDownloadMb', 1),
        whatsappPreviewMaxMb: number(value.whatsappPreviewMaxMb, 5, 'whatsappPreviewMaxMb', 0),
        dataDir,
        originalsDir: join(dataDir, 'media'),
        previewDir,
        // How Hermes sees previewDir (the compose file mounts it at the same path in both containers).
        hermesPreviewDir: value.hermesPreviewDir ?? previewDir,
        referenceDirs,
        brandKitFile: value.brandKitFile ?? env.STUDIO_BRAND_KIT ?? join(dataDir, 'brand-kit.md'),
        people: config.people.map((person) => person.id),
    };
}

/**
 * The per-person bucket of a generation whose `requested_by` is missing or not a
 * known person key. It has the same daily cap as a person, so leaving
 * `requested_by` out never skips the per-person cap.
 */
export const UNKNOWN_PERSON = 'bilinmiyor';

/** The bucket `requestedBy` is charged to: a known person key, else UNKNOWN_PERSON. */
export function personBucket(requestedBy, people) {
    const key = typeof requestedBy === 'string' ? requestedBy.trim() : '';
    return key && key !== UNKNOWN_PERSON && people.includes(key) ? key : UNKNOWN_PERSON;
}
