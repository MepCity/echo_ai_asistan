/**
 * Ready-made compositions in the Marmara Yapay Zeka Kulübü brand. Each template turns a few Turkish
 * parameters into a composition (the same format as a free composition, see spec.js), so there is only
 * one renderer. Parameters are checked by spec.js (validateTemplate) before this runs; layouts are in
 * percent, so every aspect ratio works (9:16 is the main target).
 */

export const BRAND = {
    blue: '#3278f6',
    cyan: '#3cbdfa',
    navy: '#0f1c47',
    accent: '#1e6bf5',
    light: '#f1f5f9',
    gradient: ['#3278f6', '#3cbdfa'],
    club: 'Marmara Yapay Zeka Kulübü',
    slogan: 'Öğren · Paylaş · Üret',
};

const gradientBg = { gradient: [BRAND.blue, BRAND.cyan], angle: 160 };
const navyBg = { gradient: [BRAND.navy, '#16306e'], angle: 170 };

/** Template catalogue: description, parameters (for the tool schema and validation), default length. */
export const TEMPLATES = {
    etkinlik: {
        label: 'Etkinlik duyurusu',
        defaultSeconds: 15,
        params: {
            baslik: { type: 'string', max: 80, required: true, description: 'Etkinliğin adı.' },
            tarih: { type: 'string', max: 40, description: 'Tarih, ör. "12 Mart Perşembe".' },
            saat: { type: 'string', max: 20, description: 'Saat, ör. "18.00".' },
            yer: { type: 'string', max: 60, description: 'Yer, ör. "Recep Tayyip Erdoğan Külliyesi B-201" ya da "Online".' },
            konusmaci: { type: 'string', max: 60, description: 'Konuşmacı (isteğe bağlı).' },
            aciklama: { type: 'string', max: 160, description: 'Bir iki cümlelik açıklama (isteğe bağlı).' },
            cta: { type: 'string', max: 60, description: 'Son karttaki çağrı, ör. "Kayıt: bio’daki bağlantı".' },
            gorsel: { type: 'asset', kind: 'image', description: 'Arka plan görseli (isteğe bağlı): gen_… ya da gönderilen görselin yolu.' },
        },
    },
    ozel_gun: {
        label: 'Özel gün',
        defaultSeconds: 10,
        params: {
            baslik: { type: 'string', max: 70, required: true, description: 'Günün adı, ör. "29 Ekim Cumhuriyet Bayramı".' },
            mesaj: { type: 'string', max: 180, description: 'Kısa kutlama/anma mesajı.' },
            gorsel: { type: 'asset', kind: 'image', description: 'Arka plan görseli (isteğe bağlı).' },
        },
    },
    alinti: {
        label: 'Alıntı / konuşmacı',
        defaultSeconds: 12,
        params: {
            alinti: { type: 'string', max: 220, required: true, description: 'Alıntı metni (tırnaksız).' },
            kisi: { type: 'string', max: 60, required: true, description: 'Söyleyen kişi.' },
            unvan: { type: 'string', max: 80, description: 'Unvanı / kurumu (isteğe bağlı).' },
            foto: { type: 'asset', kind: 'image', description: 'Kişinin fotoğrafı (isteğe bağlı).' },
        },
    },
    slayt: {
        label: 'Görsel slayt gösterisi',
        defaultSeconds: 20,
        params: {
            baslik: { type: 'string', max: 70, description: 'Açılış başlığı (isteğe bağlı).' },
            gorseller: { type: 'assets', kind: 'image', min: 1, max: 10, required: true, description: 'Sırayla gösterilecek görseller (gen_… ya da gönderilen görsellerin yolları), 1-10 adet.' },
            yazilar: { type: 'strings', max: 10, itemMax: 80, description: 'Her görselin altına kısa yazı (isteğe bağlı, görsellerle aynı sırada).' },
            kapanis: { type: 'string', max: 60, description: 'Kapanış kartı yazısı (isteğe bağlı).' },
        },
    },
};

const text = (value, props) => ({ type: 'text', text: value, ...props });

/** Seconds of each part, scaled to the total: parts are weights. */
function split(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    let start = 0;
    return weights.map((weight, index) => {
        const length = index === weights.length - 1 ? total - start : Math.round((total * weight * 100) / sum) / 100;
        const part = { start: Math.round(start * 100) / 100, duration: Math.round(length * 100) / 100 };
        start += length;
        return part;
    });
}

function brandFooter(delay = 0.3) {
    return [
        { type: 'logo', variant: 'logo-dark', x: 30, y: 70, w: 40, animation: 'pop', delay },
        text(BRAND.slogan, { x: 10, y: 84, w: 80, size: 40, weight: 600, align: 'center', color: BRAND.light, animation: 'fade-up', delay: delay + 0.4 }),
    ];
}

function etkinlik(p, seconds) {
    const [a, b, c] = split(seconds, [3, 5, 3]);
    const details = [
        p.tarih && ['📅', p.tarih],
        p.saat && ['⏰', p.saat],
        p.yer && ['📍', p.yer],
        p.konusmaci && ['🎤', p.konusmaci],
    ].filter(Boolean);
    const second = {
        ...b,
        transition: 'slide-up',
        background: p.gorsel ? { image: p.gorsel, dim: 0.62, kenburns: true } : navyBg,
        elements: [
            text(p.baslik, { x: 8, y: 16, w: 84, size: 64, weight: 800, color: '#ffffff', animation: 'fade-up', delay: 0.15, shadow: true }),
            { type: 'shape', x: 8, y: 36, w: 18, h: 0.6, gradient: BRAND.gradient, radius: 4, animation: 'wipe', delay: 0.4 },
            ...details.map(([icon, value], index) =>
                text(`${icon}  ${value}`, { x: 8, y: 41 + index * 9, w: 84, size: 50, weight: 700, color: BRAND.light, animation: 'slide-left', delay: 0.6 + index * 0.35, shadow: true }),
            ),
        ],
    };
    const closing = [];
    if (p.aciklama) closing.push(text(p.aciklama, { x: 9, y: 20, w: 82, size: 48, weight: 600, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.2 }));
    closing.push(text(p.cta ?? 'Seni de bekliyoruz!', { x: 10, y: p.aciklama ? 48 : 36, w: 80, size: 52, weight: 800, align: 'center', color: BRAND.navy, background: BRAND.light, animation: 'pop', delay: 0.6 }));
    return {
        background: { color: BRAND.navy },
        scenes: [
            {
                ...a,
                background: gradientBg,
                elements: [
                    { type: 'shape', shape: 'circle', x: 58, y: -8, w: 70, color: '#ffffff', opacity: 0.12, animation: 'zoom-in' },
                    { type: 'shape', shape: 'circle', x: -25, y: 72, w: 60, color: BRAND.navy, opacity: 0.18, animation: 'zoom-in', delay: 0.2 },
                    { type: 'logo', variant: 'logo-dark', x: 30, y: 12, w: 40, animation: 'pop', delay: 0.1 },
                    text('ETKİNLİK', { x: 8, y: 40, w: 84, size: 40, weight: 800, align: 'center', color: BRAND.navy, uppercase: true, animation: 'fade', delay: 0.4 }),
                    text(p.baslik, { x: 8, y: 46, w: 84, size: 84, weight: 900, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.6, shadow: true }),
                ],
            },
            second,
            { ...c, transition: 'zoom', background: gradientBg, elements: [...closing, ...brandFooter(1)] },
        ],
    };
}

function ozelGun(p, seconds) {
    const [a, b] = split(seconds, [5, 4]);
    return {
        background: { color: BRAND.navy },
        scenes: [
            {
                ...a,
                background: p.gorsel ? { image: p.gorsel, dim: 0.45, kenburns: true } : navyBg,
                elements: [
                    { type: 'shape', x: 35, y: 30, w: 30, h: 0.5, gradient: BRAND.gradient, radius: 4, animation: 'wipe', delay: 0.3 },
                    text(p.baslik, { x: 7, y: 36, w: 86, size: 88, weight: 900, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.5, shadow: true }),
                    p.mesaj ? text(p.mesaj, { x: 10, y: 60, w: 80, size: 46, weight: 500, align: 'center', color: BRAND.light, animation: 'fade', delay: 1.4, shadow: true }) : null,
                ].filter(Boolean),
            },
            {
                ...b,
                background: gradientBg,
                elements: [
                    text(BRAND.club, { x: 8, y: 40, w: 84, size: 58, weight: 800, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.2 }),
                    ...brandFooter(0.6),
                ],
            },
        ],
    };
}

function alinti(p, seconds) {
    const [a, b] = split(seconds, [6, 4]);
    const size = p.alinti.length > 140 ? 52 : p.alinti.length > 80 ? 60 : 70;
    return {
        background: { color: BRAND.navy },
        scenes: [
            {
                ...a,
                background: navyBg,
                elements: [
                    text('“', { x: 6, y: 8, w: 30, size: 260, weight: 900, color: BRAND.cyan, font: 'serif', animation: 'pop' }),
                    text(p.alinti, { x: 9, y: 26, w: 82, size, weight: 600, color: '#ffffff', font: 'serif', italic: true, animation: 'fade-up', delay: 0.5 }),
                    text(`— ${p.kisi}`, { x: 9, y: 74, w: 82, size: 46, weight: 800, color: BRAND.cyan, animation: 'slide-left', delay: 1.6 }),
                ],
            },
            {
                ...b,
                transition: 'slide-up',
                background: gradientBg,
                elements: [
                    p.foto ? { type: 'image', asset: p.foto, shape: 'circle', x: 30, y: 14, w: 40, border: '#ffffff', shadow: true, animation: 'pop', delay: 0.1 } : null,
                    text(p.kisi, { x: 8, y: p.foto ? 40 : 30, w: 84, size: 70, weight: 900, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.4 }),
                    p.unvan ? text(p.unvan, { x: 10, y: p.foto ? 49 : 40, w: 80, size: 42, weight: 600, align: 'center', color: BRAND.navy, animation: 'fade', delay: 0.7 }) : null,
                    ...brandFooter(0.9),
                ].filter(Boolean),
            },
        ],
    };
}

function slayt(p, seconds) {
    const images = p.gorseller;
    const weights = [...(p.baslik ? [2] : []), ...images.map(() => 3), 2];
    const parts = split(seconds, weights);
    const scenes = [];
    let index = 0;
    if (p.baslik) {
        scenes.push({
            ...parts[index++],
            background: gradientBg,
            elements: [
                { type: 'logo', variant: 'logo-dark', x: 30, y: 18, w: 40, animation: 'pop' },
                text(p.baslik, { x: 8, y: 42, w: 84, size: 80, weight: 900, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.4, shadow: true }),
            ],
        });
    }
    images.forEach((asset, i) => {
        const caption = p.yazilar?.[i];
        scenes.push({
            ...parts[index++],
            transition: i % 2 ? 'zoom' : 'fade',
            background: { image: asset, kenburns: i % 2 ? 'out' : true },
            elements: [
                caption ? text(caption, { x: 7, y: 8, w: 86, size: 50, weight: 800, align: 'center', color: '#ffffff', background: '#0f1c47cc', animation: 'fade-down', delay: 0.3 }) : null,
                { type: 'logo', variant: 'logo-dark', x: 77, y: 92.5, w: 18, animation: 'none' },
            ].filter(Boolean),
        });
    });
    scenes.push({
        ...parts[index++],
        background: gradientBg,
        elements: [text(p.kapanis ?? BRAND.club, { x: 8, y: 36, w: 84, size: 62, weight: 900, align: 'center', color: '#ffffff', animation: 'fade-up', delay: 0.2 }), ...brandFooter(0.5)],
    });
    return { background: { color: BRAND.navy }, scenes };
}

const BUILDERS = { etkinlik, ozel_gun: ozelGun, alinti, slayt };

/** The composition (without size/audio) for a checked template call. */
export function templateComposition(name, params, seconds) {
    const build = BUILDERS[name];
    if (!build) throw new Error(`unknown template ${name}`);
    return build(params, seconds);
}
