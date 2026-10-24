# Lucida Data

Lucida'nın Amplitude metriklerini (abone sayıları, retention, ders başlatma, DAU, haftalık ders, ders süreleri)
gösteren, şifreyle açılan statik sayfa. GitHub Pages'te yayında.

- `index.html` — sayfa. Rakam içermez; açılışta şifre ister, `data.enc.json`'u tarayıcıda çözer.
- `data.enc.json` — veri, AES-256-GCM ile şifreli. Anahtarı `keys.json`'daki RSA-OAEP açık anahtarıyla sarılı.
- `keys.json` — açık anahtar + şifreyle (PBKDF2-SHA256) kilitlenmiş özel anahtar. Şifrenin kendisi hiçbir yerde saklanmaz.

## Yenileme

Her sabah 09:00 (İstanbul) bir Claude rutini Amplitude'dan rakamları çeker, claude.ai'deki
"Lucida Data" artifact'ının veri deposuna yazar, oradaki altı dokümanı indirip:

    node scripts/build.mjs <dokümanların-klasörü>

ile `data.enc.json`'u yeniden üretir ve `main`'e push eder. Bu adım şifre gerektirmez.

## Şifreyi değiştirmek

    LUCIDA_PASSWORD='yeni' OLD_PASSWORD='eski' node scripts/set-password.mjs

ardından `keys.json`'u commit + push et. Anahtar çifti aynı kalır, `data.enc.json`'a dokunmak gerekmez.
