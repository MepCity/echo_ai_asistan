<!--
  DÜZENLENEBİLİR DOSYA. Sunucudaki kopyası /opt/echo/brand-kit.md; kurulum onu sadece yoksa
  oluşturur, senin düzenlemelerin güncellemelerde korunur. Değiştirdikten sonra bir şey
  yeniden başlatmana gerek yok: Hermes get_brand_kit ile her seferinde güncel halini okur.
-->
# Marmara Yapay Zeka Kulübü · Marka Kiti

> Bu dosya düzenlenmek için var. Renkleri, tonu ve şablonları kulübün güncel ihtiyacına göre değiştir.

## Kimlik

- **Ad:** Marmara Yapay Zeka Kulübü (Marmara Üniversitesi yapay zeka kulübü)
- **Kısa ad:** Marmara AI
- **Slogan:** Öğren · Paylaş · Üret
- **Logo (açık zemin):** https://sosyal.marmaraai.com/marmara/logo.svg
- **Logo (koyu zemin):** https://sosyal.marmaraai.com/marmara/logo-dark.svg
  Üretimde referans olarak `reference_image: "logo"` ya da `"logo-dark"` verilebilir; ama logoyu
  modele çizdirmek yerine görselde logo için boş bir köşe bırakıp gerçek logoyu sonradan eklemek
  daha güvenlidir.

## Renkler

| Rol | Renk |
| --- | --- |
| Marka gradyanı | #3278f6 → #3cbdfa (mavi → açık mavi) |
| Lacivert (koyu zemin, başlık) | #0f1c47 |
| Vurgu | #1e6bf5 |
| Açık zemin | #f1f5f9 |

Prompt'ta renkleri açıkça yaz: "brand gradient from #3278f6 to #3cbdfa, deep navy #0f1c47
background, accent #1e6bf5, light #f1f5f9".

## Ton (metin ve ses)

- Samimi, öğrenci odaklı, meraklı.
- Teknik ama anlaşılır; jargon gerekiyorsa kısaca açıkla.
- Abartısız: "devrim", "inanılmaz", "çığır açan" gibi şişirilmiş ifadeler yok.
- "Sen" diliyle hitap; kısa cümleler.

## Görsel kurallar

- Temiz, modern, teknoloji estetiği; bol boşluk; sade kompozisyon.
- Marka gradyanı ve lacivert ana renkler; en fazla bir vurgu rengi.
- Klişe yok: parlayan robot beyni, mavi dijital insan kafası, binary yağmuru, el sıkışan robot,
  stok fotoğraf gülümsemeleri.
- Sahte logo, uydurma marka, bozuk/anlamsız yazı yok. Görselde yazı gerekiyorsa kısa ve az olsun;
  tercihen yazıyı ve logoyu sonradan gerçek fontla ekle (TryPost/Canva).
- Logo için net bir köşe bırak (tercihen sağ alt ya da sol üst, kenarlardan %8 içeride).
- Gerçek kişileri (konuşmacılar dahil) modele çizdirme; konuşmacı görseli için gerçek fotoğraf kullan.

## Platform oranları

| Platform | Oran | `platform` değeri |
| --- | --- | --- |
| Instagram gönderi | 4:5 (kare: 1:1) | `instagram` / `instagram_kare` |
| Instagram / WhatsApp hikâye | 9:16 | `story` |
| LinkedIn | 1:1 (dikey: 4:5) | `linkedin` / `linkedin_dikey` |
| X | 16:9 | `x` |

Görseli hedef platformun oranında üret; sonradan kırpılmasın. Birden fazla platform için her
oran ayrı bir üretimdir (ayrı kredi).

## Şablonlar (prompt iskeletleri)

Köşeli parantezleri doldur. Görsel prompt'ları İngilizce daha iyi sonuç verir; metinler Türkçe.

### Özel gün kutlaması (23 Nisan, 29 Ekim, 19 Mayıs…)

> Clean modern celebratory illustration for [GÜN, ör. Republic Day of Türkiye, 29 October],
> [sembol: Turkish flag colours subtly combined with the brand gradient #3278f6→#3cbdfa],
> minimal shapes, generous whitespace, deep navy #0f1c47 background, no text, no logos,
> empty top-left corner for the club logo.

Metin: kısa, içten kutlama + kulübün imzası. Siyasi yorum yok.

### Anma (10 Kasım ve benzeri)

> Respectful, calm commemorative visual for [10 November, Atatürk Memorial Day],
> muted navy #0f1c47 and soft greys, single subtle light accent, lots of empty space,
> no celebration elements, no confetti, no bright colours, no text, no logos.

Metin: saygılı, sade; kutlama dili, emoji ve "harika" gibi ifadeler yok. Atatürk'ün yüzünü
modele çizdirme; gerekiyorsa gerçek, telifsiz bir fotoğraf kullan.

### Etkinlik duyurusu

> Modern tech event poster background for [konu, ör. "Intro to LLMs" workshop],
> abstract [konuya uygun motif: neural network lines / code brackets / data points],
> brand gradient #3278f6→#3cbdfa, navy #0f1c47, large empty area in the [üst/orta] for the
> title, empty corner for logo, no text.

Metin: ne, ne zaman, nerede, kim için, nasıl kayıt (link). Tarih/saat/yer uydurma; bilmiyorsan sor.

### Workshop / eğitim

> Hands-on learning scene, [laptop with code editor / notebook with diagrams], students' hands
> only (no faces), clean desk, soft daylight, brand blue accents #1e6bf5, minimal, no text.

Metin: ne öğrenilecek (2-3 madde), ön koşul, ne getirilmeli, kontenjan.

### Konuşmacı duyurusu

> Minimal speaker announcement layout background, navy #0f1c47 with brand gradient arc,
> circular empty frame on the [sol/sağ] for the speaker photo, space for name and title, no text,
> no people.

Konuşmacı fotoğrafı ve adı sonradan eklenir; kişiyi yapay zekayla üretme.

### Sonuç / teşekkür paylaşımı

> Warm thank-you visual after [etkinlik], abstract confetti-free light shapes in brand gradient,
> light background #f1f5f9, sense of community, no text, no logos.

Metin: katılımcılara ve konuşmacılara teşekkür, 1-2 öne çıkan an, sonraki etkinliğe davet.

## Ses

- Seslendirme: kısa, doğal, samimi; 1-2 paragrafı geçmesin.
- Müzik: sade, enerjik ama yorucu olmayan; reels/hikâye için 15-30 sn genelde yeter. Sözsüz tercih et.
