# Lucida Data

Lucida'nın Amplitude metriklerini (abone sayıları, retention, ders başlatma, DAU, haftalık ders, ders süreleri)
gösteren, şifreyle açılan statik sayfa. GitHub Pages'te yayında.

- `index.html` — sayfa. Rakam içermez; açılışta şifre ister, `data.enc.json`'u tarayıcıda çözer.
- `data.enc.json` — veri, AES-256-GCM ile şifreli. Anahtarı `keys.json`'daki RSA-OAEP açık anahtarıyla sarılı.
- `engagement.html` — ikinci sayfa (Product Engagement). Metrikler ham event'lerden (Amplitude, RevenueCat) hesaplanır,
  günlük değerler zaman çizelgesi olarak gösterilir.
- `engagement/metrics.json` — Engagement metriklerinin listesi: etiket, birim, açıklama ve rutinin uyguladığı hesaplama tarifi. Rakam içermez.
- `engagement.enc.json` — Engagement metriklerinin günlük geçmişi, `data.enc.json` ile aynı şekilde şifreli.
- `keys.json` — açık anahtar + şifreyle (PBKDF2-SHA256) kilitlenmiş özel anahtar. Şifrenin kendisi hiçbir yerde saklanmaz.

## Yenileme

Her sabah 09:00 (İstanbul) bir Claude rutini Amplitude'dan rakamları çeker, claude.ai'deki
"Lucida Data" artifact'ının veri deposuna yazar, oradaki altı dokümanı indirip:

    node scripts/build.mjs <dokümanların-klasörü>

ile `data.enc.json`'u yeniden üretir ve `main`'e push eder. Bu adım şifre gerektirmez.

Engagement geçmişi aynı artifact'ın `engagement` koleksiyonunda, metrik başına bir dokümanda durur
(`{ updatedAt, points: [{ d, v, n?, of? }] }`, gün başına bir nokta). Rutin her sabah yalnızca son 7 günü
yeniden hesaplayıp birleştirir (yeni metrikte bir kez geriye dönük doldurur), sonra:

    node scripts/build-engagement.mjs <engagement-dokümanlarının-klasörü>

ile `engagement.enc.json`'u üretir.

## Şifreyi değiştirmek

    LUCIDA_PASSWORD='yeni' OLD_PASSWORD='eski' node scripts/set-password.mjs

ardından `keys.json`'u commit + push et. Anahtar çifti aynı kalır, `data.enc.json`'a dokunmak gerekmez.
