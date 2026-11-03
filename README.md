# Spicy Lyrics AI Translator & Romaja — V50.0.0

Spicetify Marketplace'de yayınlanan **Spicy Lyrics** için Türkçe altyazı ve romanizasyon eklentisi. Bu sürüm V49'un dört dosyalı Marketplace paketini temel alır.

## V50'de neler düzeltildi?

- **Şarkı geçişleri:** Bir şarkıdan diğerine geçildiğinde eski Gemini/GTX istekleri iptal edilir. Hızlı geçişlerde yeni şarkının sözleri biraz oturmadan çeviri başlamaz; eski şarkının yanıtı yeni şarkıya yazılmaz.
- **İleri/geri sarma:** Aynı şarkıda seek yapmak isteği yeniden başlatmaz; mevcut satır çevirileri önbellekten kullanılır.
- **Tek Gemini kuyruğu ve hız sınırlaması:** Aynı anda birden çok şarkının Gemini istekleri çalışmaz. Başlangıçlar arasında en az 9 saniye bulunur; gerçek kota/yoğunluk geri dönüşleri ayrıca bekletilir. Her grupta en fazla iki deneme vardır.
- **Daha az çağrı:** Normalde 18 satır aynı Gemini isteğinde çevrilir (V49: 8); biraz daha uzun istek bütçesi ve zaman aşımı kullanılır. 18 satırın yanıt süresi ve kalitesi yine sağlayıcıya bağlıdır.
- **503 ve 429 ayrımı:** 503 yoğunluk hatasında *model* geçici bekletilir; aynı yoğun modeli dört anahtarla tekrar tekrar zorlamaz. 429'da RetryInfo/Retry-After ve günlük kota işaretlerini dikkate alır. Google günlük kotaları Pasifik saatiyle gece yarısı sıfırlar.
- **Kalite modu (varsayılan açık):** Bir Gemini anahtarı varsa ve AI çalışmıyorsa kötü GTX/MyMemory Türkçe çevirileri **hiç üretilmez veya gösterilmez**. Romanizasyon gerektiğinde bağımsız devam edebilir. Bu nedenle kesinti sırasında bazı Türkçe satırlar boş kalabilir. Kalite modunu kapatırsanız yedek çeviriler gösterilir, ancak kaliteleri garanti değildir.
- **V49 eski çeviri temizliği:** V49 veya daha eski sürümlerde `source: gemini` olarak kaydedilmiş, fakat kalite sürümüyle doğrulanmamış Türkçe çeviriler **bir kez geçersiz kılınır**. Daha önce alınmış romanizasyon korunur. Böylece eski yanlış çeviriler yeni sürümde güvenilir sanılmaz. Eski çevirilerin yeniden oluşturulması API kotası kullanır; bu tek seferlik bir geçiştir.
- **Kaydet ≠ Sıfırla:** Sağ tık ayarlarında `Kaydet`, API anahtarlarını ve kalite modunu değiştirir ama tüm önbelleği silmez. Ayrı `Önbelleği sıfırla` işlemi bilerek temizleme içindir; soğuma/bekleme süreleri temizlenmez.
- **Gözlemlenebilir durum:** AI/TR düğmesinin üzerine gelince V50, toplam Gemini çağrısı, başarı, 429 ve 503 sayaçları görünür. DevTools'ta `__spicyTRDiagnostics()` çağrısı API anahtarlarını açıklamadan ayrıntı verir. Sayaçlar o Spotify oturumuna aittir.
- **Geriye uyumluluk:** Mevcut `spicy_tr_gemini_keys`, `spicy_tr_godmode_v35` ve `spicy_tr_quality_first_v49` ayar anahtarları korunmuştur.

## Kurulum / Marketplace güncellemesi

1. Bu ZIP içindeki `spicy-tr.js`, `manifest.json`, `marketplace-icon.png`, `README.md` dosyalarının **tamamını** GitHub deposunun **main** dalının köküne yükleyin (öncekilerin yerine yazın).
2. Commit ve push gerçekleştirin. Manifest içindeki `version` **50.0.0**, JS başlığı da **50.0.0** olmalıdır. Marketplace'in yeni sürümü fark etmesini bekleyin.
3. Marketplace'te güncellemeyi kurun ve Spotify'ı yeniden başlatın. AI/TR düğmesinin ipucunda **SpicyTR V50** yazdığını kontrol edin.
4. Aynı eklentinin hem manuel kurulu kopyasını hem Marketplace kopyasını aynı anda çalıştırmayın.

### Manuel yükleme

`spicy-tr.js` dosyasını Spicetify'nin `Extensions` klasörüne koyun, ardından `spicetify config extensions spicy-tr.js` (henüz aktif değilse) ve `spicetify apply` komutlarını çalıştırıp Spotify'ı yeniden başlatın.

Windows: `%appdata%\spicetify\Extensions` — macOS/Linux: `~/.config/spicetify/Extensions`

## Kullanım

- Spicy Lyrics'in kendi `A` romanizasyon seçeneğini kapalı tutun (orijinal karakterleri korumak için).
- Eklenti `AI`/`TR` düğmesine **sol tık**: altyazı görünürlüğü.
- **Sağ tık**: Gemini anahtarlarını girin/değiştirin, kalite modunu açın/kapatın, `Kaydet` veya ayrı `Önbelleği sıfırla`.
- Sıradan bir ayar değişikliği için **Önbelleği sıfırla'ya basmayın**. İlk V50 açılışında eski şüpheli Gemini Türkçe çevirileri zaten otomatik olarak temizlenir.
- Chrome/Spotify DevTools'ta `__spicyTRDiagnostics()` ile oturumun istek sayılarını ve kalan bekleme sürelerini kontrol edebilirsiniz. DEBUG logları için `localStorage.setItem('spicy_tr_debug','true')` ve Spotify'ı yeniden başlatın.
- API anahtarlarınızı **kimseyle paylaşmayın**. JS paketinin içinde sizin anahtarlarınız yoktur; anahtarlar Spotify'ın yerel ayar alanındadır.

## Sınırlamalar

- **Hiçbir istemci kodu Google'ın `503` yoğunluk sorununu veya gerçek `429` kotalarını ortadan kaldıramaz.** Bu sürüm fazla ve çakışan istekleri azaltır; yanıtların her zaman gelmesini garantilemez.
- Google kotaları **API anahtarı başına değil Google projesi başınadır**. Farklı hesaplarda açılmış anahtarların mutlaka farklı proje/kota kullandığı varsayılamaz. Her proje/modelin gerçek limitini Google AI Studio'da kontrol edin: <https://aistudio.google.com/rate-limit>.
- Gemini'nin ürettiği Türkçe çevirinin semantik doğruluğu her satırda garanti edilemez. Kalite modu, özellikle bağlamdan kopuk ücretsiz yedek çeviri hatalarını azaltır; insan çevirmeni yerine geçmez.
- Otomatik testler **12 senaryoda geçti** (JS/DOM/HTTP simülasyonları). Gerçek Spotify/Spicy Lyrics uygulamasında, kullanıcının API anahtarlarıyla veya canlı Google servisiyle uçtan uca test gerçekleştirilmedi.

Resmî API belgeleri: [Gemini modelleri](https://ai.google.dev/gemini-api/docs/models), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [API hata kodları](https://ai.google.dev/gemini-api/docs/api-errors).

Kaynak proje: <https://github.com/korelili/spicetify-spicy-lyrics-tr> — `@korelili`.
