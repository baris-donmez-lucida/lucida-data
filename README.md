# Lucida Data

Lucida'nın Amplitude metriklerini gösteren, şifreyle açılan statik site. GitHub Pages'te yayında.

## Product Engagement v2 (ana sayfa)

Ödeme yapan aboneler ürünü gerçekten kullanıyor mu ve alışkanlık iyiye mi gidiyor: sol menüde 11 bölüm (Genel Bakış,
Aktif Kullanım, Konuşma, Dersler, Node Sistemi, Yeni Aboneler, Yerleşik Aboneler, Retention, Memnuniyet, Değişiklikler,
Tanımlar ve Veri Sağlığı), her metrik gün gün timeline ve oranıyla; üstte tarih aralığı, önceki dönem karşılaştırması
ve tek boyutlu filtreler (platform | ülke | sürüm, + abone tipi). Eski sayfalar menünün "Eski veriler" kısmında.

- `index.html` — sayfa. Rakam içermez; şifreyle `product.enc.json`'u tarayıcıda çözer. Yerelde
  `index.html?plain=<dosya>` şifresiz bir payload okur (yalnızca `localhost` / `127.0.0.1`).
- `product/queries.json` — 35 Amplitude sorgusu (son 90 tam UTC gün; yeni abone funnel'ları 17 hafta).
- `product/metrics.json` — metrik kataloğu: sekme, birim, kaynak, pay / payda, dönem kuralı, North Star tanımı
  (`northstar_def.default`, tek yerden değişir).
- `product/changes.json` — değişiklik günlüğü (elle düzenlenir); tüm timeline'larda dikey çizgi.
- `product/ROUTINE.md` — her sabahki yenileme adımları ve bir kerelik kurulum.
- `product.enc.json` — veri, diğerleriyle aynı şekilde şifreli.
- `scripts/build-product.mjs`, `scripts/product-lib.mjs` — ham yanıtları ayrıştırıp payload'ı kurar ve şifreler.
  Eksik ya da başarısız bir ham dosya build'i durdurmaz; ona bağlı kartlar "veri yok" gösterir.

Yenileme (ayrıntı `product/ROUTINE.md`'de): sorguların ham yanıtları ve `_meta.json` bir klasöre, geçmiş
(`base`, `abandon_after_1min`) "Lucida Data" artifact'ının `product-history` koleksiyonundan bir klasöre indirilir, sonra:

    node scripts/build-product.mjs <ham-klasör> <geçmiş-klasörü>

İlk kurulumda kabul testi: `--check <baseline.json>` (repoya girmez). Yerel test: `--plain <çıktı.plain.json>`.
Ayrıştırıcı testleri: `node --test scripts/*.test.mjs` (gerçek yanıt örnekleri `fixtures/`'ta, repoya girmez).

## Eski sayfalar

- `genel.html` — ilk sayfa (abone sayıları, retention, ders başlatma, DAU, haftalık ders, ders süreleri). Rakam içermez;
  açılışta şifre ister, `data.enc.json`'u tarayıcıda çözer.
- `data.enc.json` — veri, AES-256-GCM ile şifreli. Anahtarı `keys.json`'daki RSA-OAEP açık anahtarıyla sarılı.
- `engagement.html` — ikinci sayfa (Product Engagement). Metrikler ham event'lerden (Amplitude, RevenueCat) hesaplanır,
  günlük değerler zaman çizelgesi olarak gösterilir.
- `engagement/metrics.json` — Engagement metriklerinin listesi: etiket, birim, açıklama ve rutinin uyguladığı hesaplama tarifi. Rakam içermez.
- `engagement.enc.json` — Engagement metriklerinin günlük geçmişi, `data.enc.json` ile aynı şekilde şifreli.
- `dashboard.html` — üçüncü sayfa (Product Dashboard), yalnız aboneler. Overview sekmesi: aktif abone (node başlatan)
  DAU/WAU/MAU, konuşma süresi, node'lar, uygulamada geçen süre, mağaza abonelikleri. Dersler sekmesi (`#dersler`):
  yeni abonelerin ilk 7 günde 1.–5. dersi tamamlama oranı (ders adımları) ve başlangıç versiyonu
  karşılaştırması. Aktivasyon sekmesi (`#aktivasyon`): yeni paid kullanıcıların ilk ödeme haftasına göre 7 günde
  node başlatma/tamamlama ve 3+/5+/10+ node oranı (haftalık ya da günlük kohort), ilk 24 saatte 1+/2+/3+ node (günlük). Her kartın kendi tarih ve kırılım seçimi var.
- `dashboard/queries.json` — Product Dashboard'un Amplitude sorguları (90 gün, her filtre kırılımı tek sorguda) ve RevenueCat talimatı. Rakam içermez.
- `dashboard.enc.json` — Product Dashboard verisi, aynı şekilde şifreli.
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

Product Dashboard geçmiş saklamaz: rutin her sabah `dashboard/queries.json`'daki sorguları son 90 tam UTC günü için
çalıştırır, ham yanıtları (ve RevenueCat haftalık abonelik dosyası `rc.json`'u) bir klasöre koyar, sonra:

    node scripts/build-dashboard.mjs <ham-yanıtların-klasörü>

ile `dashboard.enc.json`'u üretir. Ders sorguları (`les_*`) 7 günlük pencere kullanır; penceresi kapanmamış kohortlar
(son 8 gün) sayfada gösterilmez. Aktivasyon sorguları (`pa_*`) 17 haftayı kapsar (`<WSTART>` = dünün haftasının Pazartesi'si − 16 hafta);
biri eksikse yalnız Aktivasyon sekmesi düşer.
`dashboard/queries.json` → `versionGroups` arka arkaya çıkan sürümleri Dersler'de tek versiyon sayar (şu an 2.8.7–2.8.8).

## Şifreyi değiştirmek

    LUCIDA_PASSWORD='yeni' OLD_PASSWORD='eski' node scripts/set-password.mjs

ardından `keys.json`'u commit + push et. Anahtar çifti aynı kalır, `data.enc.json`'a dokunmak gerekmez.
