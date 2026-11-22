<!-- brand-kit-version: 3 -->
<!--
  DÜZENLENEBİLİR DOSYA. Sunucudaki kopyası /opt/echo/brand-kit.md; kurulum onu sadece yoksa
  oluşturur, senin düzenlemelerin güncellemelerde korunur. Değiştirdikten sonra bir şey
  yeniden başlatmana gerek yok: Hermes get_brand_kit ile her seferinde güncel halini okur.
-->
# Marmara Yapay Zeka Kulübü · Marka Kiti

> Bu bir kural kitabı değil, kısa bir rehber. Renklerimizi, logomuzu ve sesimizi bil; gerisinde
> özgürsün. Her afiş farklı görünebilir, yeter ki kulübün afişi olduğu belli olsun.

## Kimlik

- **Ad:** Marmara Yapay Zeka Kulübü (Marmara Üniversitesi yapay zeka kulübü)
- **Kısa ad:** Marmara AI
- **Slogan:** Öğren · Paylaş · Üret
- **Ruh:** yapay zekaya meraklı öğrenciler; birlikte öğrenen, paylaşan ve bir şeyler üreten bir topluluk.

## Renk paleti

Afişlerde bu renklerden beslen; hepsini kullanmak, her afişi lacivert yapmak ya da her yerde
gradyan koymak zorunda değilsin. Bir rengi vurgu olarak kullanmak, açık ya da beklenmedik bir
zemin seçmek, başka renklerle eşleştirmek serbest.

| Renk | Kod |
| --- | --- |
| Mavi (marka) | #3278f6 |
| Açık mavi (marka) | #3cbdfa |
| Lacivert | #0f1c47 |
| Vurgu mavisi | #1e6bf5 |
| Açık zemin | #f1f5f9 |

## Ton (metin ve ses)

- Samimi, öğrenci odaklı, meraklı.
- Teknik ama anlaşılır; jargon gerekiyorsa kısaca açıkla.
- Abartısız: "devrim", "inanılmaz", "çığır açan" gibi şişirilmiş ifadeler yok.
- "Sen" diliyle hitap; kısa cümleler.

## Logo

- **Açık zemin:** https://sosyal.marmaraai.com/marmara/logo.svg
- **Koyu zemin:** https://sosyal.marmaraai.com/marmara/logo-dark.svg
- Görsel üretiminde gerçek logo dosyası modele referans olarak kendiliğinden verilir (`logo: true`,
  varsayılan). Model onu olduğu gibi, net görünecek bir yere koyar; yerini kompozisyona göre model
  seçer. Belirli bir köşe istenirse `logo_konum` (alt-sag, alt-sol, ust-sag, ust-sol) ver.
  `logo_zemin`: logonun duracağı zemin açıksa `acik` (lacivert yazılı logo), koyuysa `koyu`.
- Logo bozuk ya da yanlış çıkarsa `add_logo` gerçek logoyu birebir ekler (kredi harcamaz).

## Afiş yazısı

- `baslik`: görselde aynen yazılacak kısa Türkçe başlık (ideal 2-6 kelime), Türkçe karakterleri doğru:
  ç ğ ı İ ö ş ü. İsteğe bağlı `alt_metin`: tarih · saat · yer ya da kısa bir cümle.
- Geçit bunları ve küçük "Marmara Yapay Zeka Kulübü" yazısını aynen yazdırır; yazının nerede ve nasıl
  duracağına model karar verir. Uzun metin görselde değil gönderi metninde.
- Kullanıcı açıkça yazısız/logosuz arka plan isterse `baslik` verme, `logo: false` kullan.

## İlham / stil yelpazesi

Her istekte bir yön seç ya da ikisini karıştır; bir önceki afişin stilini tekrar etme.

- Tipografi odaklı: kocaman, cesur harfler görselin kendisi
- 3D render: parlak, yumuşak ışıklı nesneler, oyuncak/kil hissi
- Kolaj / karışık teknik: kâğıt dokusu, kesik fotoğraflar, bant, el yazısı
- Retro / Y2K: krom, piksel, eski arayüzler, oyunbaz şekiller
- Minimalist İsviçre stili: ızgara, net tipografi, az ama güçlü öğe
- İzometrik: küçük, detaylı bir dünya (kampüs, laboratuvar, veri şehri)
- Fotogerçekçi editoryal: dergi kapağı gibi ışık ve kadraj
- İllüstrasyon: el çizimi, düz renkler, sıcak karakterler
- Fütüristik arayüz: HUD, paneller, veri katmanları
- Kâğıt kesme: katmanlı kâğıt, derinlik ve gölge
- Gradyan mesh: akışkan renkler, soyut organik formlar
- Bunların dışında konuya uyan her şey: grafiti, risograf, sinema afişi, bilim dergisi diyagramı…

Kompozisyon da özgür: yakın plan bir nesne, tek bir güçlü metafor, tam sayfa tipografi, beklenmedik
bir açı. "Laptop başında bir grup öğrenci" tek seçenek değil; konuya özgü bir fikir ara.

## Kaçın

- Klişeler: parlayan robot beyni, mavi dijital insan kafası, binary yağmuru, el sıkışan robot,
  stok fotoğraf gülümsemeleri.
- Bozuk ya da anlamsız yazı, uydurma harfler, verilen metin dışında kelime.
- Sahte logolar ya da kulüp logosunun yeniden çizilmiş hali; başka marka logoları.
- Gerçek kişilerin (tanınmış kamu figürleri ve konuşmacılar dahil) üretilmiş yüzleri: gerçek fotoğraf
  daha iyi; kullanıcı gönderirse `reference_image` ya da `edit_image` ile kullan.
- Anma günlerinde (10 Kasım ve benzeri) kutlama havası: saygılı ve sade bir ton.

## Özel günler ve anma

- **Kutlama (23 Nisan, 29 Ekim, 19 Mayıs…):** içten ve sıcak; bayrak renkleri marka paletiyle
  birlikte kullanılabilir. `baslik` ör. "29 Ekim Cumhuriyet Bayramı Kutlu Olsun". Gönderi metni kısa,
  içten bir kutlama ve kulübün imzası. Siyasi yorum yok.
- **Anma (10 Kasım ve benzeri):** saygılı, sakin, sade; konfeti, parlak renkler ve kutlama öğeleri
  yok. `baslik` ör. "10 Kasım · Saygı ve Özlemle". Metin saygılı; kutlama dili, emoji ve "harika" gibi
  ifadeler yok. Atatürk portresi için gerçek, telifsiz bir fotoğraf daha uygun; kullanıcı gönderirse
  `edit_image` ya da `reference_image` ile kullanılabilir.

## Gönderi metni ipuçları

- Etkinlik: ne, ne zaman, nerede, kim için, nasıl kayıt (link). Tarih/saat/yer uydurma; bilmiyorsan sor.
- Workshop: ne öğrenilecek (2-3 madde), ön koşul, ne getirilmeli, kontenjan.
- Konuşmacı: adı, unvanı, konu; fotoğraf gönderildiyse onu kullan.
- Teşekkür: katılımcılara ve konuşmacılara teşekkür, 1-2 öne çıkan an, sonraki etkinliğe davet.

## Platform oranları

| Platform | Oran | `platform` değeri |
| --- | --- | --- |
| Instagram gönderi | 4:5 (kare: 1:1) | `instagram` / `instagram_kare` |
| Instagram / WhatsApp hikâye | 9:16 | `story` |
| LinkedIn | 1:1 (dikey: 4:5) | `linkedin` / `linkedin_dikey` |
| X | 16:9 | `x` |

Görseli hedef platformun oranında üret; sonradan kırpılmasın. Her oran ayrı bir üretimdir (ayrı kredi).

## Çözünürlük

Varsayılan 1k: sosyal medya için yeterli, en ucuzu (GPT Image ve Nano Banana yaklaşık 1,5 kredi). 2k
(`yuksek_cozunurluk: true`) yalnızca baskı, büyük ekran/projeksiyon ya da açıkça "yüksek çözünürlük"
istendiğinde (GPT Image ~2,75, Nano Banana ~2 kredi). 4k yalnızca açıkça istenirse ve sadece Nano Banana ile.

## Ses

- Seslendirme: kısa, doğal, samimi; 1-2 paragrafı geçmesin.
- Müzik: sade, enerjik ama yorucu olmayan; reels/hikâye için 15-30 sn genelde yeter. Sözsüz tercih et.
