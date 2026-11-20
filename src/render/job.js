import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositionHtml } from './html.js';
import { probeDuration, renderVideo } from './engine.js';
import { AUDIO_MIMES, IMAGE_MIMES, LIMITS, RenderInputError, checkBuilt, validateJob } from './spec.js';
import { templateComposition } from './templates.js';
import { captionsFrom, transcribe } from './whisper.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg' };
export const VOICEOVER_DELAY = 0.4;
const SAFE_ASSET_ID = /^(?:logo|logo-dark|a\d{1,2})$/;

/** { id: 'image' | 'audio' } of a job's decoded assets, after the count/size/type checks. */
export function assetKindsOf(assets) {
    const entries = Object.entries(assets ?? {});
    if (entries.length > LIMITS.assets) throw new RenderInputError(`Bir videoda en fazla ${LIMITS.assets} dosya kullanılabilir.`);
    let total = 0;
    const kinds = {};
    for (const [id, asset] of entries) {
        if (!SAFE_ASSET_ID.test(id)) throw new RenderInputError('Geçersiz dosya kimliği.');
        const kind = IMAGE_MIMES.has(asset.mime) ? 'image' : AUDIO_MIMES.has(asset.mime) ? 'audio' : null;
        if (!kind) throw new RenderInputError(`Desteklenmeyen dosya türü: ${String(asset.mime).slice(0, 40)}.`);
        if (asset.bytes.length > LIMITS.assetBytes) throw new RenderInputError('Dosyalardan biri çok büyük (en fazla 15 MB).');
        total += asset.bytes.length;
        kinds[id] = kind;
    }
    if (total > LIMITS.totalAssetBytes) throw new RenderInputError('Dosyaların toplamı çok büyük (en fazla 50 MB).');
    return kinds;
}

/** Scene times scaled to a new length (a voiceover made the video longer). */
function stretch(composition, from, to) {
    if (from === to) return composition;
    const factor = to / from;
    return { ...composition, scenes: composition.scenes.map((scene) => ({ ...scene, start: Math.round(scene.start * factor * 1000) / 1000, duration: Math.round(scene.duration * factor * 1000) / 1000 })) };
}

/**
 * Runs one render job. job: the JSON the studio sent; assets: { id: { mime, bytes } }. Writes into
 * a new folder under workRoot (the caller removes it). Resolves { file, workDir, frames, ms, seconds,
 * captions }. deps are injectable for tests (render, transcribe, probe).
 */
export async function runRenderJob({ job, assets, workRoot, signal, log = () => {}, maxSeconds = LIMITS.maxSeconds, deps = {} }) {
    const render = deps.render ?? renderVideo;
    const speechToText = deps.transcribe ?? transcribe;
    const probe = deps.probe ?? probeDuration;
    const assetKinds = assetKindsOf(assets);
    const checked = validateJob(job, { assetKinds });
    const workDir = mkdtempSync(join(workRoot, 'job-'));
    const files = {};
    mkdirSync(join(workDir, 'a'));
    for (const [id, asset] of Object.entries(assets)) {
        const name = `${id}.${EXT[asset.mime]}`;
        writeFileSync(join(workDir, 'a', name), asset.bytes);
        files[id] = { path: `/a/${name}`, file: join(workDir, 'a', name), mime: asset.mime };
    }

    let seconds = checked.seconds;
    const audio = checked.audio ?? {};
    if (audio.voiceover) {
        const spoken = await probe(files[audio.voiceover].file, { signal });
        if (spoken) seconds = Math.min(maxSeconds, Math.max(seconds, Math.ceil((spoken + VOICEOVER_DELAY + 0.8) * 10) / 10));
    }

    let composition = checked.template ? templateComposition(checked.template, checked.params, seconds) : stretch(checked.composition, checked.seconds, seconds);
    checkBuilt(composition, { seconds, assetKinds });
    composition = { ...composition, width: checked.size.width, height: checked.size.height, fps: checked.size.fps, duration: seconds };

    let captions = [];
    if (audio.voiceover && audio.subtitles) {
        const result = await speechToText(files[audio.voiceover].file, { workDir, signal });
        captions = captionsFrom(result.segments, { offset: VOICEOVER_DELAY });
        log('info', `render subtitles: ${captions.length} cards`);
    }

    const html = compositionHtml(composition, { assetPath: (id) => files[id]?.path ?? '/missing', captions });
    const served = {};
    for (const asset of Object.values(files)) if (asset.mime.startsWith('image/')) served[asset.path] = { file: asset.file, mime: asset.mime };
    const output = join(workDir, 'video.mp4');
    const result = await render({
        html,
        assets: served,
        size: { width: composition.width, height: composition.height, fps: composition.fps, duration: seconds },
        audio: { music: audio.music ? files[audio.music].file : null, voiceover: audio.voiceover ? files[audio.voiceover].file : null, musicVolume: audio.musicVolume ?? 0.25, voiceoverDelay: VOICEOVER_DELAY },
        output,
        signal,
        workDir,
        log,
    });
    return { file: output, workDir, frames: result.frames, ms: result.ms, seconds, captions: captions.length, width: composition.width, height: composition.height, fps: composition.fps };
}
