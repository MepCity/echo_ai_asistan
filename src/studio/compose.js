import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The club logo, composited onto a finished generation with ImageMagick (never drawn by the model).
 * The original file is only read; the result is a new PNG ("final") next to it. ImageMagick is called
 * with argument arrays (execFile, no shell). `run(args)` is injectable so tests need no ImageMagick.
 *
 * Logo files (deploy/oracle/brand, copied into the image by the Dockerfile):
 * - logo.png: navy lettering, for light backgrounds;
 * - logo-dark.png: light lettering, for dark backgrounds.
 * Which one is used follows the average brightness of the corner the logo goes in.
 */

export const LOGO_CORNERS = ['alt-sag', 'alt-sol', 'ust-sag', 'ust-sol'];
export const DEFAULT_LOGO_CORNER = 'alt-sag';
/** Turkish name of a corner (approval card, answers). */
export const CORNER_NAMES = { 'alt-sag': 'sağ alt', 'alt-sol': 'sol alt', 'ust-sag': 'sağ üst', 'ust-sol': 'sol üst' };
/** English name of a corner, for the image prompt. */
export const CORNER_PROMPT = { 'alt-sag': 'bottom-right', 'alt-sol': 'bottom-left', 'ust-sag': 'top-right', 'ust-sol': 'top-left' };

/** Logo width as a share of the image width, and the margin from the edges as a share of the shorter side. */
export const LOGO_WIDTH_SHARE = 0.12;
export const LOGO_MARGIN_SHARE = 0.05;
/** Below this mean brightness (0..1, grey) the corner counts as dark and gets the light logo. */
export const DARK_THRESHOLD = 0.5;

export const DEFAULT_LOGO_DIR = fileURLToPath(new URL('../../deploy/oracle/brand/', import.meta.url));

function pngSize(bytes) {
    if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    return null;
}

/** Where the logo goes: { x, y, width, height } in pixels of a `width`x`height` image. */
export function logoBox({ width, height, corner = DEFAULT_LOGO_CORNER, logoWidth, logoHeight }) {
    if (!LOGO_CORNERS.includes(corner)) throw new Error(`unknown logo corner ${corner}`);
    const w = Math.max(1, Math.round(width * LOGO_WIDTH_SHARE));
    const h = Math.max(1, Math.round((w * logoHeight) / logoWidth));
    const margin = Math.round(Math.min(width, height) * LOGO_MARGIN_SHARE);
    const right = corner.endsWith('sag');
    const bottom = corner.startsWith('alt');
    return { x: right ? width - margin - w : margin, y: bottom ? height - margin - h : margin, width: w, height: h };
}

/** The logo variant for a corner of this mean brightness (0..1): the light logo on dark, the navy one on light. */
export const variantFor = (brightness) => (brightness < DARK_THRESHOLD ? 'logo-dark' : 'logo');

/** The ImageMagick binary: STUDIO_MAGICK, else `magick` (ImageMagick 7, Alpine), else `convert` (ImageMagick 6). */
export function findMagick(env = process.env) {
    if (env.STUDIO_MAGICK) return env.STUDIO_MAGICK;
    try {
        execFileSync('magick', ['-version'], { stdio: 'ignore', timeout: 10_000 });
        return 'magick';
    } catch {
        return 'convert';
    }
}

/** run(args) → Promise<stdout>: one ImageMagick call, arguments as an array, never through a shell. */
export function execFileRunner(binary = null, { timeoutMs = 60_000 } = {}) {
    let bin = binary;
    return (args) =>
        new Promise((done, fail) => {
            bin ??= findMagick();
            execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
                if (error) fail(new Error(`${bin} failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
                else done(String(stdout));
            });
        });
}

export function createLogoCompositor({ logoDir = DEFAULT_LOGO_DIR, run = execFileRunner() } = {}) {
    const logos = {};
    function logo(variant) {
        if (!logos[variant]) {
            const file = join(logoDir, `${variant}.png`);
            const size = pngSize(readFileSync(file));
            if (!size) throw new Error(`${file} is not a PNG`);
            logos[variant] = { file, ...size };
        }
        return logos[variant];
    }

    /** Mean grey brightness (0..1) of a region of `input`. */
    async function brightness(input, box) {
        const out = await run([input, '-crop', `${box.width}x${box.height}+${box.x}+${box.y}`, '+repage', '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']);
        const value = Number.parseFloat(String(out).trim());
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`brightness not readable: ${String(out).slice(0, 60)}`);
        return value;
    }

    return {
        /**
         * Writes `output` (PNG): `input` with the club logo in `corner`. `input` is never changed.
         * Returns { file, bytes, sha256, width, height, corner, variant, brightness }.
         */
        async apply({ input, output, width, height, corner = DEFAULT_LOGO_CORNER }) {
            if (!LOGO_CORNERS.includes(corner)) throw new Error(`unknown logo corner ${corner}`);
            if (!(width > 0 && height > 0)) throw new Error('image size unknown');
            const shape = logo('logo');
            const box = logoBox({ width, height, corner, logoWidth: shape.width, logoHeight: shape.height });
            const light = await brightness(input, box);
            const variant = variantFor(light);
            const tmp = `${output}.tmp.png`;
            try {
                await run([input, '(', logo(variant).file, '-resize', `${box.width}x${box.height}!`, ')', '-geometry', `+${box.x}+${box.y}`, '-composite', `png:${tmp}`]);
                const bytes = readFileSync(tmp);
                const size = pngSize(bytes);
                if (!size || size.width !== width || size.height !== height) throw new Error('composited image has the wrong size');
                renameSync(tmp, output);
                return { file: output, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width, height, corner, variant, brightness: light };
            } finally {
                rmSync(tmp, { force: true });
            }
        },
    };
}
