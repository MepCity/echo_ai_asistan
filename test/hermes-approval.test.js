import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Turkish body of Hermes' WhatsApp approval card (deploy/oracle/hermes/plugins/echo_onay_tr,
 * Python, runs inside Hermes). render.py is driven through its JSON stdin/stdout mode; the plugin's
 * wrapping of Hermes' functions is tested by test/hermes_onay_tr_test.py (fake Hermes modules).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'deploy/oracle/hermes/plugins/echo_onay_tr');
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const skip = python ? false : 'python3 is not installed';

function render(cases) {
    const result = spawnSync(python, ['-B', '-I', join(PLUGIN, 'render.py')], { input: JSON.stringify(cases), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}
const one = (server, tool, args, hint) => render([{ server, tool, args, hint }])[0];

// What Hermes' WhatsApp adapter puts around the body (locales/tr.yaml written by configure.py), so the
// whole card can be checked against WhatsApp's 1024-character interactive body.
const DESCRIPTION = readFileSync(join(PLUGIN, '__init__.py'), 'utf8').match(/^DESCRIPTION = "(.*)"$/m)[1];
const card = (body) => `⚠️ *Onayın gerekiyor*\n\n\`\`\`\n${body}\n\`\`\`\n\nNot: ${DESCRIPTION}...\n\n5 dakika içinde cevap vermezsen hiçbir şey yapılmaz.`;
const FORBIDDEN = /UNTRUSTED|MCP|readOnlyHint|Arguments|[{}]/;

// Every write tool of TryPost's MCP servers (app/Mcp/Tools, app/Marmara/Inbox/Mcp), read-only ones left out.
const TRYPOST_WRITE_TOOLS = [
    'reply-to-inbox-item-tool', 'create-idea-stage-tool', 'create-idea-tool', 'delete-idea-stage-tool', 'delete-ideas-tool',
    'duplicate-idea-tool', 'move-ideas-tool', 'reorder-idea-stages-tool', 'update-idea-stage-tool', 'update-idea-tool',
    'create-label-tool', 'delete-label-tool', 'update-label-tool', 'add-post-note-reaction-tool', 'approve-post-tool',
    'attach-media-from-upload-tool', 'attach-media-from-url-tool', 'clear-post-recurrence-tool', 'create-post-note-tool',
    'create-post-tool', 'create-posts-tool', 'delete-post-note-tool', 'delete-post-tool', 'publish-post-tool',
    'reject-post-tool', 'remove-post-note-reaction-tool', 'request-media-upload-tool', 'set-post-recurrence-tool',
    'update-post-note-tool', 'update-post-tool', 'activate-repurpose-tool', 'create-repurpose-tool', 'delete-repurpose-tool',
    'disable-repurpose-tool', 'pause-repurpose-tool', 'resume-repurpose-tool', 'update-repurpose-tool', 'create-signature-tool',
    'delete-signature-tool', 'update-signature-tool', 'copy-posting-schedule-tool', 'create-pinterest-board-tool',
    'generate-posting-schedule-tool', 'move-post-to-slot-tool', 'reorder-queue-tool', 'update-posting-schedule-tool',
    'add-design-tool', 'rename-design-tool',
];

describe('approval card: studio tools', { skip }, () => {
    it('generate_image: platform, ratio, credits and the Turkish summary', () => {
        const body = one('studio', 'generate_image', { prompt: 'A clean poster…', platform: 'instagram', ozet: '8 Mart Dünya Kadınlar Günü afişi', requested_by: 'yasir' }, { aspect_ratio: '4:5', credits: 1.5, resolution: '1k' });
        assert.equal(body, '🎨 Görsel üretilecek · Instagram (4:5) · yaklaşık 1.5 kredi\nKonu: 8 Mart Dünya Kadınlar Günü afişi');
    });

    it('generate_image: 2k is called out, a reference is named, no ozet falls back to the prompt', () => {
        const body = one('studio', 'generate_image', { prompt: 'Neon lights over Istanbul', yuksek_cozunurluk: true, reference_image: 'logo' }, { aspect_ratio: '1:1', credits: 2.75, resolution: '2k' });
        assert.equal(body, '🎨 Görsel üretilecek · 1:1 · yüksek çözünürlük · yaklaşık 2.75 kredi\nTarif: “Neon lights over Istanbul”\nReferans: kulüp logosu');
    });

    it('generate_image without a hint (studio unreachable) still renders, without credits', () => {
        assert.equal(one('studio', 'generate_image', { prompt: 'x', platform: 'story', ozet: 'Etkinlik hikâyesi' }), '🎨 Görsel üretilecek · Hikâye\nKonu: Etkinlik hikâyesi');
    });

    it('generate_audio: speech and music', () => {
        assert.equal(one('studio', 'generate_audio', { kind: 'speech', text: 'Merhaba arkadaşlar!', ozet: 'Duyuru seslendirmesi' }, { credits: 1 }), '🔊 Seslendirme üretilecek · yaklaşık 1 kredi\nKonu: Duyuru seslendirmesi\nMetin: “Merhaba arkadaşlar!”');
        assert.equal(one('studio', 'generate_audio', { kind: 'music', prompt: 'calm lofi', duration: 30, ozet: 'Reels müziği' }, { credits: 4.5, duration: 30 }), '🎵 Müzik üretilecek · 30 sn · yaklaşık 4.5 kredi\nKonu: Reels müziği');
    });

    it('attach_to_trypost: to a post, or as a new draft with its text', () => {
        assert.equal(one('studio', 'attach_to_trypost', { generation_id: 'gen_1', post_id: 'p-1', ozet: '8 Mart afişi' }), "📎 Üretilen görsel TryPost'taki gönderiye eklenecek\nKonu: 8 Mart afişi");
        assert.equal(one('studio', 'attach_to_trypost', { generation_id: 'gen_1', social_account_id: 'a', content: 'Yeni etkinlik!' }), "📝 Üretilen görselle TryPost'ta yeni taslak oluşturulacak\nMetin: “Yeni etkinlik!”");
    });

    it('add_logo: no credits, the corner in Turkish', () => {
        assert.equal(one('studio', 'add_logo', { generation_id: 'gen_1' }), '🔖 Görsele kulüp logosu eklenecek (kredi harcamaz)');
        assert.equal(one('studio', 'add_logo', { generation_id: 'gen_1', konum: 'ust-sol', ozet: '8 Mart afişi' }), '🔖 Görsele kulüp logosu eklenecek (kredi harcamaz)\nKöşe: sol üst\nKonu: 8 Mart afişi');
    });

    it('edit_image: credits from the hint, the change, the source when it is a sent picture', () => {
        assert.equal(
            one('studio', 'edit_image', { generation_id: 'gen_1', talimat: 'Başlığı “Yapay Zeka Atölyesi” yap', ozet: 'Atölye afişi düzeltmesi' }, { aspect_ratio: '4:5', credits: 1.5, resolution: '1k' }),
            '🪄 Görsel düzenlenecek · yaklaşık 1.5 kredi\nDeğişiklik: “Başlığı “Yapay Zeka Atölyesi” yap”\nKonu: Atölye afişi düzeltmesi',
        );
        assert.equal(
            one('studio', 'edit_image', { kaynak_gorsel: '/opt/data/cache/images/a.jpg', talimat: 'arka planı lacivert yap', yuksek_cozunurluk: true }, { credits: 2.75, resolution: '2k' }),
            '🪄 Görsel düzenlenecek · yüksek çözünürlük · yaklaşık 2.75 kredi\nDeğişiklik: “arka planı lacivert yap”\nKaynak: gönderdiğin görsel',
        );
    });

    it('generate_image with secenek: 2 says two images and their total credits', () => {
        assert.equal(
            one('studio', 'generate_image', { prompt: 'p', platform: 'instagram', secenek: 2, ozet: 'Atölye afişi, iki seçenek' }, { aspect_ratio: '4:5', credits: 3, resolution: '1k', count: 2 }),
            '🎨 Görsel üretilecek · Instagram (4:5) · 2 görsel · yaklaşık 3 kredi\nKonu: Atölye afişi, iki seçenek',
        );
        assert.equal(one('studio', 'generate_image', { prompt: 'p', secenek: 2, ozet: 'x' }), '🎨 Görsel üretilecek · 2 görsel\nKonu: x', 'no hint: still two images');
    });

    it('generate_image shows the exact headline', () => {
        assert.equal(
            one('studio', 'generate_image', { prompt: 'p', platform: 'instagram', baslik: '8 Mart Dünya Kadınlar Günü', ozet: '8 Mart afişi' }, { aspect_ratio: '4:5', credits: 1.5, resolution: '1k' }),
            '🎨 Görsel üretilecek · Instagram (4:5) · yaklaşık 1.5 kredi\nKonu: 8 Mart afişi\nBaşlık: “8 Mart Dünya Kadınlar Günü”',
        );
    });
});

describe('approval card: TryPost tools', { skip }, () => {
    it('create-post-tool: draft, scheduled (Istanbul time), publish now; text cut at 200 characters', () => {
        const long = 'Yapay zekâ atölyemiz başlıyor! '.repeat(20);
        const [draft, scheduled, now] = render([
            { server: 'trypost', tool: 'create-post-tool', args: { content: long, social_account_id: 'acc', content_type: 'instagram_feed', media: [{ upload_token: 'secret-token' }] } },
            { server: 'trypost', tool: 'create-post-tool', args: { content: 'Kısa', status: 'scheduled', scheduled_at: '2026-12-03T12:30:00Z', social_account_id: 'acc', content_type: 'linkedin_post' } },
            { server: 'trypost', tool: 'create-post-tool', args: { content: 'Şimdi', status: 'publishing', social_account_id: 'acc', content_type: 'x_post' } },
        ]);
        const [first, text, media] = draft.split('\n');
        assert.equal(first, "📝 TryPost'ta taslak oluşturulacak · Instagram");
        assert.ok(text.startsWith('Metin: “Yapay zekâ atölyemiz başlıyor!'));
        assert.equal([...text.slice('Metin: “'.length, -1)].length, 200);
        assert.ok(text.endsWith('…”'));
        assert.equal(media, 'Medya: 1 dosya');
        assert.ok(!draft.includes('secret-token'));
        assert.equal(scheduled, '📅 Gönderi planlanacak · LinkedIn · 3 Aralık 15:30\nMetin: “Kısa”');
        assert.equal(now, '🚀 Gönderi HEMEN yayınlanacak · X\nMetin: “Şimdi”');
    });

    it('create-posts-tool lists the platforms of its destinations', () => {
        const body = one('trypost', 'create-posts-tool', { status: 'draft', content: 'Ortak metin', destinations: [{ social_account_id: '1', content_type: 'instagram_feed' }, { social_account_id: '2', content_type: 'x_post' }, { social_account_id: '3', content_type: 'linkedin_post' }] });
        assert.equal(body, "📝 TryPost'ta 3 taslak oluşturulacak · Instagram, X, LinkedIn\nMetin: “Ortak metin”");
    });

    it('update, delete, publish, approve and reject', () => {
        const bodies = render([
            { server: 'trypost', tool: 'update-post-tool', args: { post_id: 'p', content: 'Düzeltilmiş metin', status: 'scheduled', scheduled_at: '2026-03-08T07:00:00Z' } },
            { server: 'trypost', tool: 'delete-post-tool', args: { post_id: 'p' } },
            { server: 'trypost', tool: 'publish-post-tool', args: { post_id: 'p' } },
            { server: 'trypost', tool: 'publish-post-tool', args: { post_id: 'p', queue: 'next' } },
            { server: 'trypost', tool: 'approve-post-tool', args: { post_id: 'p', publish_now: true } },
            { server: 'trypost', tool: 'reject-post-tool', args: { post_id: 'p' } },
        ]);
        assert.deepEqual(bodies, [
            "📝 TryPost'taki gönderi düzenlenecek\nYeni metin: “Düzeltilmiş metin”\nDurum: planlanacak · 8 Mart 10:00",
            '❌ Gönderi silinecek (geri alınamaz)',
            '🚀 Gönderi HEMEN yayınlanacak',
            '📅 Taslak gönderi kuyruğa eklenecek · ilk boş zamana',
            '🚀 Onay bekleyen gönderi onaylanıp HEMEN yayınlanacak',
            '🚫 Onay bekleyen gönderi reddedilecek',
        ]);
    });

    it('reply-to-inbox-item-tool shows the reply itself, not ids', () => {
        const body = one('trypost', 'reply-to-inbox-item-tool', { item_id: '9b2c0f6e-uuid', text: 'Teşekkürler, cumartesi görüşürüz!', request_id: 'r-1' });
        assert.equal(body, '💬 Yorum ya da mesaja cevap gidecek (hemen gönderilir)\nCevap: “Teşekkürler, cumartesi görüşürüz!”');
    });

    it('add-design-tool: title, tags, collection and who adds it; never the media token or id', () => {
        const bodies = render([
            { server: 'trypost', tool: 'add-design-tool', args: { media: { upload_token: 'secret-token' }, title: 'Sarıyer’de Aranan Aslan', tags: ['aranan aslan', 'sarıyer'], on_behalf_of: 'Yasir' } },
            { server: 'trypost', tool: 'add-design-tool', args: { media: { id: 'media_123456' }, title: 'Atölye afişi', tags: [], folder: 'Afişler' } },
            { server: 'trypost', tool: 'add-design-tool', args: { media: 'x', tags: 'not-a-list' } },
        ]);
        assert.deepEqual(bodies, [
            "📁 Tasarımlar'a dosya eklenecek\nBaşlık: “Sarıyer’de Aranan Aslan”\nEtiketler: aranan aslan, sarıyer\nDosya: WhatsApp'tan gönderilen dosya\nEkleyen: Yasir",
            "📁 Tasarımlar'a dosya eklenecek\nBaşlık: “Atölye afişi”\nKoleksiyon: Afişler",
            "📁 Tasarımlar'a dosya eklenecek",
        ]);
        for (const body of bodies) assert.ok(!body.includes('secret-token') && !body.includes('media_123456'));
    });

    it('rename-design-tool: old and new title, a short design id, the Drive name stays; never the member id', () => {
        const design = '9b2c0f6e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
        const bodies = render([
            { server: 'trypost', tool: 'rename-design-tool', args: { design_id: design, title: 'Sarıyer’de Aranan Aslan', current_title: 'IMG_2041', on_behalf_of_user_id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' } },
            { server: 'trypost', tool: 'rename-design-tool', args: { design_id: design, title: 'Atölye afişi' } },
            { server: 'trypost', tool: 'rename-design-tool', args: { design_id: design, title: '  ', current_title: 'Bahar afişi' } },
            { server: 'trypost', tool: 'rename-design-tool', args: { title: ['x'] } },
        ]);
        assert.deepEqual(bodies, [
            "📝 Tasarımın başlığı değişecek · “IMG_2041” → “Sarıyer’de Aranan Aslan”\nTasarım: …3d4e5f\nDrive'daki dosya adı değişmez",
            "📝 Tasarımın başlığı değişecek\nYeni başlık: “Atölye afişi”\nTasarım: …3d4e5f\nDrive'daki dosya adı değişmez",
            "📝 Tasarımın başlığı Drive'daki dosya adına dönecek\nŞu anki başlık: “Bahar afişi”\nTasarım: …3d4e5f\nDrive'daki dosya adı değişmez",
            "📝 Tasarımın başlığı değişecek\nDrive'daki dosya adı değişmez",
        ]);
        for (const body of bodies) assert.ok(!body.includes('0199a1b2'));
    });

    it('every TryPost write tool has its own Turkish phrase', () => {
        const bodies = render(TRYPOST_WRITE_TOOLS.map((tool) => ({ server: 'trypost', tool, args: {} })));
        bodies.forEach((body, index) => {
            assert.ok(!body.startsWith('🔧'), `${TRYPOST_WRITE_TOOLS[index]} falls back to the generic card`);
            assert.doesNotMatch(body, FORBIDDEN);
        });
    });
});

describe('approval card: unknown tools, safety and length', { skip }, () => {
    it('an unknown tool gets the generic form: a key: value list, secrets masked, no JSON', () => {
        const body = one('trypost', 'create-webhook-tool', { endpoint: 'https://example.test/hook', events: ['post.published', 'post.failed'], secret_token: 'abc', meta: { a: 1 }, enabled: true });
        assert.equal(body, '🔧 create-webhook işlemi yapılacak\nendpoint: https://example.test/hook\nevents: 2 öğe\nsecret_token: ***\nmeta: 1 alan\nenabled: evet');
        const many = one('studio', 'new_tool', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, `v${i}`])));
        assert.equal(many.split('\n').at(-1), '(+3 alan daha)');
        assert.doesNotMatch(many, FORBIDDEN);
    });

    it('drops bidi overrides and zero-width characters, swaps backticks (the card is a code block)', () => {
        const body = one('trypost', 'reply-to-inbox-item-tool', { text: 'iyi‮ günler​ ```kod``` \n\n satır' });
        assert.equal(body.split('\n')[1], "Cevap: “iyi günler '''kod''' satır”");
    });

    it('stays under 600 characters, and the whole card under 1024, for any input', () => {
        const huge = 'çok uzun metin '.repeat(500);
        const cases = [
            { server: 'trypost', tool: 'create-post-tool', args: { content: huge, content_type: 'instagram_feed', media: [1, 2, 3] } },
            { server: 'trypost', tool: 'update-post-tool', args: { content: huge, scheduled_at: '2026-12-01T10:00:00Z', label_ids: [1] } },
            { server: 'trypost', tool: 'create-idea-tool', args: { title: huge, body: huge } },
            { server: 'studio', tool: 'generate_image', args: { prompt: huge, ozet: huge, platform: 'instagram', reference_image: '/opt/data/cache/images/a.png' }, hint: { aspect_ratio: '4:5', credits: 1.5 } },
            { server: 'studio', tool: 'generate_audio', args: { kind: 'speech', text: huge, ozet: huge }, hint: { credits: 1 } },
            { server: 'studio', tool: 'attach_to_trypost', args: { content: huge, ozet: huge } },
            { server: 'trypost', tool: `some-${'very-'.repeat(60)}long-tool`, args: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${'key'.repeat(20)}${i}`, huge])) },
        ];
        for (const body of render(cases)) {
            assert.ok(body.length <= 600, `${body.length}: ${body.slice(0, 60)}`);
            assert.ok(card(body).length < 1024, `card ${card(body).length}`);
            assert.doesNotMatch(body, FORBIDDEN);
        }
    });

    it('odd arguments never break it', () => {
        const bodies = render([
            { server: 'trypost', tool: 'create-post-tool', args: null },
            { server: 'trypost', tool: 'create-posts-tool', args: { destinations: 'x' } },
            { server: 'trypost', tool: 'update-post-tool', args: { scheduled_at: 'yarın' } },
            { server: 'studio', tool: 'generate_audio', args: { kind: 'video' } },
            { server: 'other', tool: '', args: {} },
        ]);
        assert.equal(bodies.length, 5);
        for (const body of bodies) assert.ok(body.length > 0 && body.length <= 600);
    });
});

describe('approval card: Hermes plugin wiring (fake Hermes modules)', { skip }, () => {
    it('python tests pass: wraps once, rewrites only trypost/studio trust-gate cards, fails safe', () => {
        const result = spawnSync(python, ['-B', '-I', join(ROOT, 'test/hermes_onay_tr_test.py')], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stderr, /Ran \d+ tests[\s\S]*OK/);
    });
});
