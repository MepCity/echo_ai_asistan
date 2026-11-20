import { randomBytes } from 'node:crypto';

/**
 * A validated composition (spec.js) as one self-contained HTML page: absolutely positioned layers,
 * CSS keyframe animations only, and a tiny fixed script (ours, with a CSP nonce) that pauses every
 * animation and seeks it to a frame's time. Nothing from the composition is ever put into the page as
 * markup, CSS or script: text is HTML-escaped, colours and numbers were checked against strict
 * patterns, and images are `/a/<n>.<ext>` paths the engine answers from the job's own files.
 *
 * Units: x, y, w, h are percent of the frame; text `size` is pixels on a frame whose shorter side is 1080 and scales
 * with the shorter side, so one composition renders the same at 720p and 1080p.
 */

export const FONT_STACK = {
    sans: "'Inter', 'Noto Sans', 'DejaVu Sans', sans-serif",
    serif: "'Noto Serif', 'DejaVu Serif', serif",
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = (value) => Number(Number(value).toFixed(4));
const pct = (start, total) => `${Math.min(100, Math.max(0, (start / total) * 100)).toFixed(4)}%`;

/** CSS background of a Background (color / gradient), images are separate <img> layers. */
function backgroundCss(background) {
    if (!background) return 'transparent';
    if (background.gradient) {
        const [from, to] = background.gradient;
        return `linear-gradient(${num(background.angle ?? 160)}deg, ${from}, ${to})`;
    }
    return background.color ?? 'transparent';
}

const ENTER = {
    none: null,
    fade: 'from { opacity: 0 } to { opacity: 1 }',
    'fade-up': 'from { opacity: 0; transform: translateY(6%) } to { opacity: 1; transform: none }',
    'fade-down': 'from { opacity: 0; transform: translateY(-6%) } to { opacity: 1; transform: none }',
    'slide-left': 'from { opacity: 0; transform: translateX(12%) } to { opacity: 1; transform: none }',
    'slide-right': 'from { opacity: 0; transform: translateX(-12%) } to { opacity: 1; transform: none }',
    pop: '0% { opacity: 0; transform: scale(0.6) } 70% { opacity: 1; transform: scale(1.05) } 100% { opacity: 1; transform: scale(1) }',
    'zoom-in': 'from { opacity: 0; transform: scale(1.25) } to { opacity: 1; transform: scale(1) }',
    wipe: 'from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 0 0 0) }',
};
const ENTER_SECONDS = { pop: 0.7, wipe: 0.9 };

/** The page for a composition; `assetPath(id)` maps an asset id to its served path. */
export function compositionHtml(composition, { assetPath, captions = [] }) {
    const { width, height, duration } = composition;
    const scale = Math.min(width, height) / 1080;
    const nonce = randomBytes(12).toString('base64');
    const css = [];
    const layers = [];
    let counter = 0;
    const name = (prefix) => `${prefix}${counter++}`;

    css.push(`
        html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #0f1c47; }
        * { box-sizing: border-box; }
        .stage { position: absolute; inset: 0; overflow: hidden; background: ${backgroundCss(composition.background)}; font-family: ${FONT_STACK.sans}; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; }
        .scene, .layer { position: absolute; inset: 0; }
        .el { position: absolute; }
        .el img, .bg img { width: 100%; height: 100%; display: block; }
        .text { white-space: pre-wrap; overflow-wrap: break-word; line-height: 1.15; }
        .cap { position: absolute; left: 7%; right: 7%; bottom: 14%; display: flex; justify-content: center; opacity: 0; }
        .cap span { background: rgba(15, 28, 71, 0.82); color: #ffffff; font-weight: 700; font-size: ${num(46 * scale)}px; line-height: 1.25; padding: ${num(12 * scale)}px ${num(24 * scale)}px; border-radius: ${num(18 * scale)}px; text-align: center; max-width: 100%; }
    `);
    for (const [key, frames] of Object.entries(ENTER)) if (frames) css.push(`@keyframes enter-${key} { ${frames} }`);
    css.push('@keyframes kenburns { from { transform: scale(1) translate(0, 0) } to { transform: scale(1.14) translate(-1.5%, -1%) } }');
    css.push('@keyframes kenburns-out { from { transform: scale(1.14) translate(1.5%, 1%) } to { transform: scale(1) translate(0, 0) } }');

    const imageTag = (asset, fit, extra = '') => `<img alt="" src="${escapeHtml(assetPath(asset))}" style="object-fit: ${fit === 'contain' ? 'contain' : 'cover'};${extra}">`;

    function backgroundLayer(background, start, length) {
        if (!background?.image) return '';
        const anim = background.kenburns === false ? '' : `animation: ${background.kenburns === 'out' ? 'kenburns-out' : 'kenburns'} ${num(length)}s linear ${num(start)}s both;`;
        // tint: the photo becomes a brand-blue duotone (greyscale, coloured with the accent), so any
        // backdrop photo stays on brand; without it the photo keeps its own colours (slideshows).
        const filter = background.tint ? ' filter: grayscale(1) contrast(1.05);' : '';
        const tint = background.tint ? '<div class="layer" style="background: #1e6bf5; mix-blend-mode: color; opacity: 0.85"></div>' : '';
        const dim = background.dim ? `<div class="layer" style="background: rgba(15, 28, 71, ${num(background.dim)})"></div>` : '';
        return `<div class="layer bg" style="overflow: hidden"><div class="layer" style="${anim}">${imageTag(background.image, 'cover', filter)}</div></div>${tint}${dim}`;
    }

    function element(el, sceneStart, sceneLength) {
        // Outer box: position and the enter animation. Inner box: the look (its own opacity, so an
        // animation ending at opacity 1 never overrides a half-transparent shape).
        const circle = el.shape === 'circle';
        const box = [`left: ${num(el.x ?? 0)}%`, `top: ${num(el.y ?? 0)}%`];
        if (el.w !== undefined) box.push(`width: ${num(el.w)}%`);
        if (circle) box.push('aspect-ratio: 1 / 1');
        else if (el.h !== undefined) box.push(`height: ${num(el.h)}%`);
        const animation = el.animation ?? 'fade';
        const delay = sceneStart + (el.delay ?? 0);
        if (ENTER[animation]) box.push(`animation: enter-${animation} ${ENTER_SECONDS[animation] ?? 0.8}s cubic-bezier(0.2, 0.8, 0.2, 1) ${num(delay)}s both`);
        const look = ['width: 100%', 'height: 100%'];
        if (el.opacity !== undefined) look.push(`opacity: ${num(el.opacity)}`);
        const wrap = (classes, inner) => `<div class="el${classes}" style="${box.join('; ')}"><div style="${look.join('; ')}">${inner}</div></div>`;

        if (el.type === 'text') {
            look.push(`color: ${el.color ?? '#ffffff'}`, `font-size: ${num((el.size ?? 56) * scale)}px`, `font-weight: ${el.weight ?? 700}`, `text-align: ${el.align ?? 'left'}`, `font-family: ${FONT_STACK[el.font ?? 'sans']}`);
            if (el.uppercase) look.push('text-transform: uppercase', `letter-spacing: ${num(0.06 * (el.size ?? 56) * scale)}px`);
            if (el.italic) look.push('font-style: italic');
            if (el.shadow) look.push('text-shadow: 0 4px 24px rgba(15, 28, 71, 0.55)');
            const pill = el.background ? ` style="display: inline-block; background: ${el.background}; padding: 0.2em 0.55em; border-radius: 0.45em; box-decoration-break: clone; -webkit-box-decoration-break: clone"` : '';
            return wrap(' text', `<span${pill}>${escapeHtml(el.text)}</span>`);
        }
        if (el.type === 'image' || el.type === 'logo') {
            const asset = el.type === 'logo' ? el.variant ?? 'logo-dark' : el.asset;
            if (el.type === 'logo' || (el.h === undefined && !circle)) {
                // Natural height: the picture keeps its own proportions.
                look[1] = 'height: auto';
                return wrap('', `<img alt="" src="${escapeHtml(assetPath(asset))}" style="width: 100%; height: auto; display: block">`);
            }
            look.push('overflow: hidden', `border-radius: ${circle ? '50%' : `${num((el.radius ?? 0) * scale)}px`}`);
            if (el.border) look.push(`border: ${num(8 * scale)}px solid ${el.border}`);
            if (el.shadow) look.push('box-shadow: 0 18px 60px rgba(15, 28, 71, 0.45)');
            const kb = el.kenburns ? ` animation: kenburns ${num(sceneLength)}s linear ${num(sceneStart)}s both;` : '';
            return wrap('', imageTag(asset, el.fit ?? 'cover', kb));
        }
        // shape
        const fill = el.gradient ? `linear-gradient(${num(el.angle ?? 135)}deg, ${el.gradient[0]}, ${el.gradient[1]})` : el.color ?? '#1e6bf5';
        look.push(`background: ${fill}`, `border-radius: ${circle ? '50%' : `${num((el.radius ?? 0) * scale)}px`}`);
        return wrap('', '');
    }

    composition.scenes.forEach((scene, index) => {
        const start = scene.start;
        const end = Math.min(duration, scene.start + scene.duration);
        const fade = Math.min(0.5, scene.duration / 4);
        const first = index === 0;
        const last = index === composition.scenes.length - 1;
        const transition = scene.transition ?? 'fade';
        const hidden = transition === 'slide-up' ? 'opacity: 1; transform: translateY(100%)' : transition === 'zoom' ? 'opacity: 0; transform: scale(1.12)' : 'opacity: 0';
        const shown = 'opacity: 1; transform: none';
        const id = name('scene');
        const frames = [];
        frames.push(`0% { ${first ? shown : hidden} }`);
        if (!first) frames.push(`${pct(start, duration)} { ${hidden} }`, `${pct(start + (transition === 'none' ? 0.001 : fade), duration)} { ${shown} }`);
        if (!last) frames.push(`${pct(end, duration)} { ${shown} }`, `${pct(end + 0.001, duration)} { opacity: 0 }`, '100% { opacity: 0 }');
        else frames.push(`100% { ${shown} }`);
        css.push(`@keyframes ${id} { ${frames.join(' ')} }`);
        const body = [`<div class="scene" style="background: ${backgroundCss(scene.background)}; animation: ${id} ${num(duration)}s linear 0s both; z-index: ${index + 1}">`];
        body.push(backgroundLayer(scene.background, start, end - start));
        for (const el of scene.elements ?? []) body.push(element(el, start, end - start));
        body.push('</div>');
        layers.push(body.join(''));
    });

    if (composition.watermark) {
        const { variant, corner } = composition.watermark;
        const w = 18;
        const x = corner.endsWith('sol') ? 5 : 100 - 5 - w;
        const y = corner.startsWith('ust') ? 3.5 : 92;
        layers.push(`<div class="el" style="left: ${x}%; top: ${y}%; width: ${w}%; z-index: 900"><img alt="" src="${escapeHtml(assetPath(variant))}" style="width: 100%; height: auto; display: block"></div>`);
    }

    captions.forEach((caption) => {
        const id = name('cap');
        const on = Math.max(0, caption.start);
        const off = Math.min(duration, caption.end);
        if (off <= on) return;
        css.push(`@keyframes ${id} { 0% { opacity: 0 } ${pct(on, duration)} { opacity: 0 } ${pct(on + 0.001, duration)} { opacity: 1 } ${pct(off, duration)} { opacity: 1 } ${pct(off + 0.001, duration)} { opacity: 0 } 100% { opacity: 0 } }`);
        layers.push(`<div class="cap" style="animation: ${id} ${num(duration)}s linear 0s both; z-index: 1000"><span>${escapeHtml(caption.text)}</span></div>`);
    });

    const script = `
        window.__ready = async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((img) => img.decode().catch(() => null)));
            for (const animation of document.getAnimations()) animation.pause();
            return true;
        };
        window.__seek = (seconds) => {
            const ms = seconds * 1000;
            for (const animation of document.getAnimations()) animation.currentTime = ms;
            return new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
        };`;

    return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${'https://render.invalid'}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<style>${css.join('\n')}</style></head>
<body><div class="stage">${layers.join('\n')}</div>
<script nonce="${nonce}">${script}</script></body></html>`;
}
