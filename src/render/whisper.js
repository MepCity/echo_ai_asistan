import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './engine.js';

/**
 * Speech to text with whisper.cpp (whisper-cli, built into the render image with the multilingual
 * "base" model; Turkish is one of its languages). Audio is first turned into 16 kHz mono WAV by
 * ffmpeg. Short segments (-ml/-sow) come back with times, which become subtitles.
 */

export const WHISPER_BIN = process.env.RENDER_WHISPER_BIN ?? 'whisper-cli';
export const WHISPER_MODEL = process.env.RENDER_WHISPER_MODEL ?? '/opt/whisper/ggml-base.bin';

/** Segments [{ start, end, text }] (seconds) from whisper.cpp's JSON output. */
export function parseWhisperJson(json) {
    const items = Array.isArray(json?.transcription) ? json.transcription : [];
    return items
        .map((item) => ({
            start: Number(item.offsets?.from ?? 0) / 1000,
            end: Number(item.offsets?.to ?? 0) / 1000,
            text: String(item.text ?? '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((item) => item.text && item.end > item.start && !/^\[.*\]$/.test(item.text));
}

/**
 * Subtitle cards from segments: consecutive segments merged up to ~`maxChars`, never longer than
 * `maxSeconds` on screen, shifted by `offset` (the voiceover's delay in the video).
 */
export function captionsFrom(segments, { maxChars = 42, maxSeconds = 3.5, offset = 0 } = {}) {
    const cards = [];
    for (const segment of segments) {
        const last = cards[cards.length - 1];
        if (last && last.text.length + 1 + segment.text.length <= maxChars && segment.end - last.start <= maxSeconds && segment.start - last.end < 0.4) {
            last.text = `${last.text} ${segment.text}`;
            last.end = segment.end;
        } else {
            cards.push({ ...segment });
        }
    }
    return cards.slice(0, 200).map((card) => ({ start: round(card.start + offset), end: round(card.end + offset), text: card.text.slice(0, 120) }));
}
const round = (value) => Math.round(value * 1000) / 1000;

/** Transcribes an audio file; resolves { text, segments }. */
export async function transcribe(file, { workDir, language = 'tr', signal, threads = 2, ffmpeg = 'ffmpeg', bin = WHISPER_BIN, model = WHISPER_MODEL } = {}) {
    const wav = join(workDir, 'speech.wav');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-t', '600', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { signal });
    const base = join(workDir, 'speech');
    await run(bin, ['-m', model, '-l', language, '-t', String(threads), '-ml', '42', '-sow', '-oj', '-of', base, '-np', '-f', wav], { signal });
    const segments = parseWhisperJson(JSON.parse(readFileSync(`${base}.json`, 'utf8')));
    return { text: segments.map((segment) => segment.text).join(' '), segments };
}
