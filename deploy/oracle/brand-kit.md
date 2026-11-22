<!-- brand-kit-version: 4 -->
<!--
  DÜZENLENEBİLİR DOSYA. Sunucudaki kopyası /opt/echo/brand-kit.md; kurulum onu sadece yoksa
  oluşturur, senin düzenlemelerin güncellemelerde korunur. Değiştirdikten sonra bir şey
  yeniden başlatmana gerek yok: Hermes get_brand_kit ile her seferinde güncel halini okur.
-->
# Marmara Yapay Zeka Kulübü · Marka Kiti

## Kimlik

- **Ad:** Marmara Yapay Zeka Kulübü (Marmara Üniversitesi yapay zeka kulübü)
- **Kısa ad:** Marmara AI

## Logo

- **Açık zemin:** https://sosyal.marmaraai.com/marmara/logo.svg
- **Koyu zemin:** https://sosyal.marmaraai.com/marmara/logo-dark.svg
- Görsel üretiminde gerçek logo dosyası modele referans olarak kendiliğinden verilir (`logo: true`,
  varsayılan). Model onu olduğu gibi, net görünecek bir yere koyar; yerini kompozisyona göre model
  seçer. Belirli bir köşe istenirse `logo_konum` (alt-sag, alt-sol, ust-sag, ust-sol) ver.
  `logo_zemin`: logonun duracağı zemin açıksa `acik` (lacivert yazılı logo), koyuysa `koyu`.
- Logo bozuk ya da yanlış çıkarsa `add_logo` gerçek logoyu birebir ekler (kredi harcamaz).

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
