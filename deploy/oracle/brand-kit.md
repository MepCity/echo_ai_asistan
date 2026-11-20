<!-- brand-kit-version: 2 -->
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
  Görsel üretiminde gerçek logo dosyası (PNG) modele referans olarak kendiliğinden verilir
  (`logo: true`, varsayılan); model onu `logo_konum` köşesine yerleştirir. Logo bozuk çıkarsa
  `add_logo` gerçek logoyu birebir ekler (kredi harcamaz).

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
- Yazı az ve net olsun: bir başlık, gerekirse bir kısa alt satır, küçük kulüp adı. Uzun paragraf
  görselde değil gönderi metninde.
- Gerçek kişilerin (konuşmacılar dahil) yüzünü modelle üretmek yerine gerçek fotoğraf daha iyi
  sonuç verir; kullanıcı fotoğraf gönderirse edit_image ya da reference_image ile kullan.

## Afiş (yayına hazır)

Afişler varsayılan olarak bitmiş üretilir: başlık, alt satır, kulüp adı ve gerçek logo görselin
içinde. Kullanıcı ayrıca bir şey eklemek zorunda kalmaz.

- **Başlık:** `baslik` alanına aynen görselde yazılacak Türkçe metni yaz (ör. "8 Mart Dünya Kadınlar
  Günü"). Kısa tut (ideal 2-6 kelime). Türkçe karakterleri doğru yaz: ç ğ ı İ ö ş ü.
- **Alt satır:** isteğe bağlı `alt_metin` (tarih · saat · yer ya da kısa bir cümle).
- Geçit bunları sabit bir kalıpla prompt'a ekler: aynen yazılacak metin, küçük "Marmara Yapay Zeka
  Kulübü" yazısı, tipografi (temiz modern sans-serif, kalın başlık, marka renkleri, yüksek kontrast)
  ve Türkçe karakter uyarısı. Prompt'ta bunları tekrar yazmana gerek yok; prompt'ta sahneyi,
  kompozisyonu ve yazının nerede duracağını anlat (ör. "headline in the upper third, left aligned").
- **Logo:** `logo: true` (varsayılan) gerçek logo dosyasını referans verir. `logo_konum`: alt-sag
  (varsayılan), alt-sol, ust-sag, ust-sol. `logo_zemin`: o köşenin zemini koyuysa `koyu` (beyaz
  yazılı logo, varsayılan), açıksa `acik` (lacivert yazılı logo).

### Kompozisyon: yazı ve logo yerleşimi

- Logo köşesi sakin kalsın: o köşede yoğun desen, yazı ya da önemli nesne olmasın.
- Başlık logo köşesinin karşı tarafında dursun: logo sağ alttaysa başlık üstte ya da sol tarafta;
  logo sol üstteyse başlık altta ya da ortada.
- Alt satır başlığın hemen altında, daha küçük; kulüp adı küçük ve başlıkla aynı hizada ya da
  logonun karşı köşesinde.
- Kenarlardan en az %5 boşluk; hiçbir yazı kenarda kesilmesin.
- Yazı zeminle güçlü kontrast yapsın: koyu zeminde beyaz/açık, açık zeminde lacivert.

### Kontrol ve düzeltme

- Sonucu kullanıcıya gösterirken başlığın doğru yazıldığını kontrol et.
- Kullanıcı yazı yanlış derse bir kez düzeltme teklif et: `edit_image` (yalnızca yazıyı değiştir)
  ya da yeniden üretim. Kendiliğinden tekrar üretme.
- Logo bozuk ya da yanlış renkteyse: `add_logo` (kredi harcamaz, gerçek logoyu birebir ekler).

### Sade arka plan (sadece istenirse)

Kullanıcı açıkça "yazısız/logosuz arka plan, ben tasarlayacağım" derse `baslik` verme, `logo: false`
kullan ve prompt'ta yazı ve logo için boş alan bırakılmasını iste ("large empty area for the title,
no text").

## Platform oranları

| Platform | Oran | `platform` değeri |
| --- | --- | --- |
| Instagram gönderi | 4:5 (kare: 1:1) | `instagram` / `instagram_kare` |
| Instagram / WhatsApp hikâye | 9:16 | `story` |
| LinkedIn | 1:1 (dikey: 4:5) | `linkedin` / `linkedin_dikey` |
| X | 16:9 | `x` |

Görseli hedef platformun oranında üret; sonradan kırpılmasın. Birden fazla platform için her
oran ayrı bir üretimdir (ayrı kredi).

## Çözünürlük

Varsayılan 1k: Instagram, LinkedIn ve X için yeterli, en ucuzu (GPT Image ve Nano Banana yaklaşık
1,5 kredi). 2k (`yuksek_cozunurluk: true`) yalnızca baskı, büyük ekran/projeksiyon ya da açıkça
"yüksek çözünürlük" istendiğinde (GPT Image ~2,75, Nano Banana ~2 kredi). 4k yalnızca açıkça
istenirse ve sadece Nano Banana ile.

## Şablonlar (prompt iskeletleri)

Köşeli parantezleri doldur. Görsel prompt'ları İngilizce daha iyi sonuç verir; metinler Türkçe.

Afişlerde `baslik` (ve gerekirse `alt_metin`) ver; logo kendiliğinden gelir.

### Özel gün kutlaması (23 Nisan, 29 Ekim, 19 Mayıs…)

> Clean modern celebratory poster for [GÜN, ör. Republic Day of Türkiye, 29 October],
> [sembol: Turkish flag colours subtly combined with the brand gradient #3278f6→#3cbdfa],
> minimal shapes, generous whitespace, deep navy #0f1c47 background, headline centered in the
> upper half, calm bottom-right corner.

`baslik`: ör. "29 Ekim Cumhuriyet Bayramı Kutlu Olsun". Gönderi metni: kısa, içten kutlama +
kulübün imzası. Siyasi yorum yok.

### Anma (10 Kasım ve benzeri)

> Respectful, calm commemorative poster for [10 November, Atatürk Memorial Day],
> muted navy #0f1c47 and soft greys, single subtle light accent, lots of empty space,
> no celebration elements, no confetti, no bright colours, quiet headline in the center.

`baslik`: ör. "10 Kasım · Saygı ve Özlemle". Metin: saygılı, sade; kutlama dili, emoji ve "harika"
gibi ifadeler yok. Atatürk portresi için gerçek, telifsiz bir fotoğraf daha uygun; kullanıcı
gönderirse edit_image ile kullanılabilir.

### Etkinlik duyurusu

> Modern tech event poster for [konu, ör. "Intro to LLMs" workshop],
> abstract [konuya uygun motif: neural network lines / code brackets / data points],
> brand gradient #3278f6→#3cbdfa, navy #0f1c47, headline large in the upper third, subline
> below it, calm bottom-right corner.

`baslik`: etkinliğin adı; `alt_metin`: tarih · saat · yer. Gönderi metni: ne, ne zaman, nerede,
kim için, nasıl kayıt (link). Tarih/saat/yer uydurma; bilmiyorsan sor.

### Workshop / eğitim

> Hands-on learning scene, [laptop with code editor / notebook with diagrams], students' hands
> only, clean desk, soft daylight, brand blue accents #1e6bf5, minimal, headline on a calm
> navy band at the top.

Metin: ne öğrenilecek (2-3 madde), ön koşul, ne getirilmeli, kontenjan.

### Konuşmacı duyurusu

> Minimal speaker announcement poster, navy #0f1c47 with brand gradient arc, circular frame on
> the [sol/sağ] for the speaker photo, speaker name as the headline and title as the subline.

Kullanıcı konuşmacının fotoğrafını gönderdiyse onu `reference_image` (ya da edit_image) ile ver;
yüzü sıfırdan üretmek yerine gerçek fotoğraf daha doğru olur. `baslik`: konuşmacının adı,
`alt_metin`: unvan · tarih.

### Sonuç / teşekkür paylaşımı

> Warm thank-you poster after [etkinlik], abstract confetti-free light shapes in brand gradient,
> light background #f1f5f9, sense of community, navy headline in the upper half.

Açık zeminde `logo_zemin: "acik"` ver.

Metin: katılımcılara ve konuşmacılara teşekkür, 1-2 öne çıkan an, sonraki etkinliğe davet.

## Ses

- Seslendirme: kısa, doğal, samimi; 1-2 paragrafı geçmesin.
- Müzik: sade, enerjik ama yorucu olmayan; reels/hikâye için 15-30 sn genelde yeter. Sözsüz tercih et.
