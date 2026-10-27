# Günlük yenileme rutini (Product Engagement v2 — index.html)

Her sabah 09:00 İstanbul'da, mevcut Lucida Data rutininden sonra çalışır. Şifre gerektirmez. Bu dosya repoya girer: içinde rakam yok, olmamalı.

## Rutine bağlama

Mevcut zamanlanmış görevin (Lucida Data günlük yenileme) prompt'unun sonuna şu paragraf eklenir:

> Ardından `product/ROUTINE.md`'deki "Her sabah" adımlarını uygula: `product/queries.json`'daki sorguları çalıştır, ham yanıtları ve `_meta.json`'u ham klasöre yaz, `product-history` geçmişini güncelle, `node scripts/build-product.mjs <raw-dir> <history-dir>` çalıştır ve yalnızca `product.enc.json`'u commit et. Bir sorgu iki denemede de başarısız olursa onu atla ve özette belirt.

## Bir kerelik kurulum

1. **Abone tabanı cohort'u.** Amplitude Lucida Prod'da (773708) dinamik cohort: "Lucida · Aktif abone tabanı (rc_subscription_status)" = user property `gp:rc_subscription_status` şu değerlerden biri: `active`, `intro`, `cancelled`, `grace_period`, `promotional` (güncel değer, zaman koşulu yok). `use_amplitude_cohorts` → `create`, ardından `get` ile `size`'ın sayı olduğunu doğrula. Cohort id'sini `product/queries.json` → `baseCohortId` alanına yaz.
   - Çapraz kontrol: RevenueCat Lucida Speak (`proj9cc11412`) "Active Subscriptions" (App Store + Play Store; Stripe 28 Eylül 2026'dan beri donuk, sayma) + aktif web_promo grant'ları. Cohort boyutu bu toplamla aynı büyüklükte olmalı; çok farklıysa cohort tanımını kontrol et.
2. **Geçmiş doldurma.** `aband_day` sorgusunu son 30 günün her biri için ayrı ayrı çalıştır (her gün için `<DAY_START>` = günün 00:00:00 UTC, `<DAY_END>` = 23:59:59 UTC) ve noktaları `abandon_after_1min` dokümanına yaz. `base` için geçmiş yok; ilk günden itibaren birikir.
   `stickiness` için de aynısı: `stick_day` sorgusunu her gün için kendi 7 günlük penceresiyle (`<WEEK_START>` = gün − 6, `<DAY_END>` = günün 23:59:59) çalıştır. (26 Eylül – 25 Ekim 2026 doldurulmuş durumda.)

## Her sabah

1. Tarihler (epoch saniye, sayı, UTC):
   - `<START>` = bugün − 90 gün, 00:00:00
   - `<END>` = dün 23:59:59
   - `<WSTART>` = dünün haftasının Pazartesi'si − 16 hafta, 00:00:00
   - `<DAY_START>` / `<DAY_END>` = dünün 00:00:00 / 23:59:59
   - `<WEEK_START>` = dün − 6 gün, 00:00:00 (`stick_day` için: dünle biten 7 günlük pencere)
2. `product/queries.json`'daki her sorguyu `query_amplitude_data` ile çalıştır: `chart` alanı varsa `chart` parametresine, `definition` alanı varsa `definition` parametresine. `projectId` 773708, `groupByLimit` sorgudaki değer, `timeSeriesLimit` = sorguda `timeSeriesLimit` varsa o, yoksa `groupByLimit`.
3. Her ham yanıtı olduğu gibi `<raw-dir>/<id>.json` olarak kaydet (araç sonucu dosyaya düştüyse o dosyayı kopyala). `success: false` dönen sorguyu bir kez yeniden dene; yine olmazsa dosyasını yazma, build script ilgili kartları "veri yok" gösterir.
4. `<raw-dir>/_meta.json`: `{ "dataDate": "<dün, YYYY-MM-DD>", "runs": { "<id>": "<sorgunun bittiği an, ISO UTC>", … }, "failed": ["<id>", …] }`. Sayfa bunu Tanımlar bölümünde gösterir.
5. Geçmiş, `engagement` sayfasındaki gibi claude.ai'deki "Lucida Data" artifact'ının veri deposunda durur: koleksiyon `product-history`, metrik başına bir doküman (`base`, `abandon_after_1min`, `stickiness`), şema `{ updatedAt, points: [...] }`. Rutin önce bu üç dokümanı `<history-dir>/<id>.json` olarak indirir.
6. Cohort boyutu: `use_amplitude_cohorts` → `get` (`baseCohortId`) → `size`; `base` dokümanına `{d: dün, v: size}` ekle.
7. `aband_day` yanıtından `{d: dün, opened, abandoned, over60}` noktasını `abandon_after_1min` dokümanına ekle (aynı gün varsa üzerine yaz). `stick_day` yanıtından `{d: dün, paid: {dau, wau}, store: {…}, web: {…}}` noktasını `stickiness` dokümanına ekle (dau = timeSeries'in son noktası, wau = overallSeries; segment sırası paid, store, web). Üç dokümanı depoya geri yaz ve `<history-dir>`'deki kopyaları güncelle.
8. `node scripts/build-product.mjs <raw-dir> <history-dir>` → `product.enc.json`. `--check` bayrağı yalnızca ilk kurulumda, yerelde kullanılır.
9. Yalnızca `product.enc.json`'u commit + push et. Ham yanıtlar, `_meta.json` ve geçmiş dosyaları repoya girmez: repo herkese açık, rakamlar yalnızca şifreli dosyada durur.

## Haftalık kontrol (Pazartesi)

- Abonelerde `gp:role_play_arm` dağılımı: `call_ok`, paid segment, son 7 gün, `gp:role_play_arm` kırılımı. `classic` ve boş dışında bir değer varsa role play kolu abonelere açılmıştır: özette uyar ve `changes.json`'a not düş. Kalıcı çözüm her segmente `gp:role_play_arm` ∈ (none), classic koşulunu eklemek; bunu rutin değil, sorgu sahibi yapar.
- `speech_zero_rate` son 7 günde %5'i geçtiyse özette uyar.
