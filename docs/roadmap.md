# Masa özellik planı

Başlangıç: 5 Ekim 2026. Özellikler mevcut yerel çalışma modelini koruyarak,
her aşamada kullanılabilir ve doğrulanmış bir sürüm oluşturacak şekilde eklenir.

**Güncel durum: 6 Ekim 2026, Masa 0.8.0 / firmware 0.8.0.** İlk altı aşamanın
yazılımı tamamlandı; kolay tekrarlar ve cron 7. aşamada eklendi. 138 uygulama
testi, firmware testleri ve 0.8.0 macOS paketinin sürüm/imza kontrolü geçti.
Kartın tam yedeği alındı; firmware 0.8.0 yüklendi. Ekran ayarlarının yeniden
başlatma sonrası kalıcılığı ve mevcut takvim/bağlantı/geçmişin korunması doğrulandı.
İlk iki aşama kendi tarihsel sürümlerini kaydeder; donanım doğrulaması ve kalan
işler aşağıda ayrı belirtilir.

## 1. Tek seferlik hatırlatma ve uygulamadan erteleme

- [x] Tarih ve saat seçerek bir kez hatırlatma; 30 dakika sonra kısayolu.
- [x] Geçmişten 5 / 15 / 30 dakika erteleme; tekrar takvimi değişmez.
- [x] Ertelenen bildirim yeniden başlatmada korunur, zamanı gelmeden gönderilmez.
- [x] Tek seferlik kayıt gönderim kuyruğuna alınınca pasifleşir; tekrar üretilmez.
- [x] Eski takvimler, teslimat kimlikleri ve cihaz ayarları korunur; dönüşümden önce yedek alınır.
- [x] Takvim, disk hatası, yeniden başlatma ve gerçek HTTP üzerinden doğrulama.

Aşağıdaki sınırlar bu aşamanın tarihsel sürümüne aittir; güncel bağımsız cihaz
çalışması 5. aşamada uygulanmıştır. Bu aşama cihaz protokolü 2 ile çalışır. Cihazın kabul ettiği eski not
erteleme ile geri çekilmez; BOOT ile kapatılır. Erteleme bilgisayar açıkken işler.

**Durum: uygulandı (Masa 0.3.0).** 38 otomatik test geçti. Arayüzün ekleme,
düzenleme, erteleme, yeniden açılma ve yeni tarihe taşıma akışları gerçek motor
ve HTTP cihaz simülatörüyle tarayıcıda doğrulandı; dar ekran görüntüsü kontrol edildi.
Motor ayrıca tinyjs'in txiki.js ortamında çalıştırıldı. Firmware derlemesi ve
OLED metin testi geçti. Yeni akış fiziksel cihazda ve native pencere üzerinde
henüz denenmedi. Bu tarihsel aşamadan sonraki tamamlandı takibi ve cihaz
eylemleri 2. aşamada uygulandı.

## 2. Tamamlandı takibi ve cihazdan eylemler

- [x] Teslimat durumundan ayrı, her bildirim için bekleyen / yapıldı / ertelendi bilgisi.
- [x] Uygulamadan tamamlandı işaretleme ve günlük tamamlanan işler görünümü.
- [x] Cihazdaki eylemleri kimlikli, kalıcı olay kuyruğunda saklama; uygulamanın
      okuyup onaylaması, aynı olayı ikinci kez işlememesi.
- [x] BOOT hareketlerini kısa basış, çift basış ve mevcut 5 saniyelik kurulum
      hareketiyle çakışmayacak şekilde tasarlama; cihazdan erteleme.
- [x] Protokol sürüm geçişi ve simülatör desteği.
- [x] Gerçek kartla takvim devri, teslimat geçmişini indirme, uygulamadan
      tamamlandı işlemini karta aktarma ve bilgisayara geri devir testi.
- [ ] Fiziksel düğmeyle tamamlandı/erteleme ve güç kesintisinde olay kalıcılığı.

**Durum: yazılım uygulandı (6 Ekim 2026; Masa 0.4.0, firmware 0.3.0).**
54 otomatik test, firmware derlemesi, OLED metin testi ve yeni C++ düğme
zamanlama testi geçti. Arayüzde Yaptım, günlük sayım, yeniden açılma,
cihazdan tamamlandı ve cihazdan erteleme akışları gerçek motor ve HTTP
simülatörüyle doğrulandı; dar ve geniş ekranlar kontrol edildi. Yeni motor
txiki.js ortamında da doğrulandı. macOS Apple Silicon uygulama paketi başarıyla
oluşturuldu. Fiziksel kart ve native pencere testi bekliyor.

Bu bölüm Masa 0.4.0 / firmware 0.3.0 davranışını kaydeder. Güncel sürümde
cihazın kendi yönettiği ertelemeler 5. aşamada açıklanır.

Teslimat bilgisi korunur; iş tamamlanınca aynı bildirimin bekleyen ertelemeleri
iptal olur, sonraki rutin devam eder. Cihaz olayları uygulama diske yazmadan
silinmez. Cihazdan erteleme, olay uygulamaya ulaştığında 15 dakika sonrasına
kurulur; bilgisayar kapalıyken süreyi cihaz yönetmesi 5. aşamaya bağlıdır.
Uygulama eski protokol 2 ile çalışmaya devam eder; düğme olayları için protokol
3 gerekir. Önce uygulama, sonra firmware güncellenir. Esnek tekrarlar ve sessiz
saatler 3. aşamada uygulandı.

## 3. Esnek tekrarlar ve rahatsız etmeyin saatleri

- [x] 1–10080 dakika aralıklarla ve iki haftada bir tekrar.
- [x] Aralıklı hatırlatmalarda seçili hafta günleri ve aynı gün içinde çalışma
      saatleri; aralık dışındaki ilk geçerli zamanı hesaplama.
- [x] Başlangıç haftası seçilen iki haftalık takvim; düzenlemede başlangıcı koruma.
- [x] Geceyi aşan sessiz saatler; OLED bildirimleri devam ederken cihaz ve
      masaüstü bildirim sesi susar.
- [x] Kaçırılan tekrarları yığmadan hesaplama; saat dilimi ve yaz saati sınır testleri.

**Durum: yazılım tamamlandı (6 Ekim 2026; Masa 0.6.0).** Takvim ve sessiz saat
akışları otomatik testlerde, gerçek motorla tarayıcıda ve native çekirdek ortamında doğrulandı.

## 4. Yedekleme ve geri yükleme

- [x] Sürümlü JSON dosyası indirme ve dosyadan içe aktarma.
- [x] Yalnızca hatırlatıcı tanımları ve sessiz saatleri dışa aktarma; cihaz
      adresini, anahtarını, Wi-Fi bilgilerini ve geçmişi dışarıya taşımama.
- [x] Önce dosyayı doğrulama ve başlık listesini gösterme; birleştirme veya
      mevcut ajandanın yerine koyma seçimi.
- [x] Değişiklikten önce tüm mevcut yerel durumun otomatik geri dönüş yedeğini alma.
- [x] Aynı kimlikleri güncelleme; aynı yedeği yeniden aktarınca kopya oluşturmama.
- [x] Bozuk dosya, eski biçimler, kapasite, yedekleme ve kayıt hatalarında mevcut
      verinin değişmediğini doğrulama.

**Durum: yazılım tamamlandı.** En fazla 100 hatırlatıcı ve 1 MB dosya kabul edilir;
bağımsız cihaz modunda toplam 24 hatırlatıcı sınırı uygulanır. Taşınabilir biçim
`masa-reminders / 1`, güncel yerel kayıt biçimi `6`'tir. İçe aktarma öncesi tam
kayıt `reminder-import-backup` alanında `{createdAt, state}` olarak saklanır.

## 5. Bilgisayardan bağımsız cihaz zamanlaması

- [x] Takvim sürümü ve saat dilimiyle birlikte ESP32'ye kalıcı takvim aktarımı.
- [x] 24 hatırlatıcı ve 24 bekleyen erteleme; düzenleme, silme, tamamlandı
      işlemleri ve yeniden eşitleme.
- [x] NTP veya Masa'nın UTC aktarımıyla güvenilir saat; yeniden başlatmada
      güvenilir saat alınana kadar zamanlamayı durdurma ve durumu gösterme.
- [x] Tek zamanlayıcı sahipliği ve açık devir seçimi; kaybolan aktarım yanıtında
      bilgisayarın aynı bildirimi yeniden üretmesini önleyen kalıcı sahiplik kaydı.
- [x] Çevrimdışı ertelemeyi cihazda başlatma; teslimat, tamamlanma ve erteleme
      kayıtlarını yeniden bağlanınca bilgisayara aktarma.
- [x] Takvim, bildirim kuyruğu ve düğme olaylarını tek atomik LittleFS kaydında
      saklama; eski NVS ve Wi-Fi verilerini koruma.
- [x] HTTP simülatöründe çevrimdışı çalışma, yeniden başlatma, kayıt hatası,
      kaybolan yanıt, tek seferlik tüketim ve sahiplik geçişi doğrulaması.
- [x] USB kartta 0.2.3 → 0.6.0 geçişi; yükleme öncesi tam flash yedeği,
      Wi-Fi/cihaz anahtarının korunması ve protokol 4 yanıtı.
- [x] Gerçek NTP eşitlemesi; açılışta güvenilir saat gelene kadar bekleme.
- [x] Karta aktarılan tek seferlik takvimden bağımsız üretim ve tekrar etmemesi.
- [x] USB yeniden başlatma sonrası takvim sürümü ve geçmişin korunması.
- [x] Masa motoruyla gerçek HTTP üzerinden takvim devri, geçmiş/tamamlandı
      eşitlemesi ve güvenli geri devir; geçici test takviminin kaldırılması.
- [ ] Bilgisayar kapalı, ağ kopuk ve USB güç kesintisi senaryolarını fiziksel
      kartta doğrulama.

**Durum: yazılım tamamlandı (Masa 0.6.0, firmware 0.6.0, protokol 4).**
Uygulamadaki **Takvimi cihazda çalıştır** seçeneği bu modu açar. Aktarım
onaylandıktan sonra bilgisayar uyurken veya Masa kapalıyken cihaz hatırlatır.
Cihaz yeniden başlatılırsa NTP ya da Masa ile saat eşitlemesi gerekir.

Cihazın `/masa-state.json` kaydı günceldir; ilk geçişte korunan NVS kaydı sonradan
ilerletilmez. Eski firmware'e dönmeden önce bağımsız modu kapatıp eşitle,
bekleyen kuyruk ve olayları boşalt ve yedek al. Eski NVS kaydı eski bildirimleri
tekrar gösterebilir; geri dönüşün bu sınırı fiziksel doğrulama gerektirir.

## 6. Boşta bilgi ekranı

- [x] Saat, sıradaki hatırlatma ve kalan süreyi 72×40 alanda 5 saniyede bir
      dönüşümlü gösterme.
- [x] Bildirime öncelik verme; bağlantı ve saat eşitleme durumlarını gösterme.
- [x] 60 saniye sonra ekranı kısma, 120 saniye sonra kapatma; BOOT ile uyandırma.
- [x] Türkçe metin ve ekran sınırlarını yazılım testleriyle doğrulama.
- [ ] Gerçek OLED görünürlüğünü, kısılmayı, uyanmayı ve düğme hareketlerini
      fiziksel cihazda doğrulama.

**Durum: yazılım tamamlandı.** Yeni bildirim ekranı uyandırır; boşta BOOT'a basmak
bilgiyi görünür hale getirir. Otomatik ekran kapanması bir işi tamamlandı saymaz.

## 7. Kolay tekrar seçenekleri ve cron

- [x] Her gün, Her saat ve Her 2 saatte hazır seçimleri; mevcut özel aralıkları koruma.
- [x] Beş alanlı cron; liste, aralık, adım, ay/gün adları ve yaygın kısayollar.
- [x] Cron örnekleri, alan doğrulaması ve sonraki üç zamanın önizlemesi.
- [x] Yerel takvim, sessiz saatler, erteleme/tamamlandı ve yedeklerde cron tanımları.
- [x] Bağımsız ESP32 cron zamanlaması; eski firmware için özellik kontrolü.
- [x] Kayıt biçimi 5 → 6 geçişinden önce yedek; sahiplik ve mevcut kayıtların korunması.
- [x] 123 uygulama testi; C++ cron/API testleri, firmware derlemesi ve native çekirdek.
- [x] Gerçek motor/HTTP simülatörüyle geniş ve dar arayüz akışları; hatalı/gecikmiş önizleme yanıtları.
- [x] Masa 0.7.0 macOS Apple Silicon paketi; sürüm ve imza kontrolü.
- [x] USB karta yükleme öncesi 4 MB flash yedeği ve SHA-256 kontrolü.
- [x] Firmware 0.7.0 yüklemesi; cron yeteneği, NTP ve mevcut takvim/Wi-Fi/anahtarın korunması.
- [ ] Cron'un gerçek USB kartta bağımsız üretim ve yeniden başlatma doğrulaması.

**Durum: yazılım ve paket tamamlandı (Masa/firmware 0.7.0).**
Saatlik hazır seçimler kayıt anından başlayan aralıkları, cron ise yerel saate
bağlı dakika kurallarını kullanır. Yaz saatindeki kayıp dakikalar atlanır;
tekrarlanan dakikalar ayrı kimliklerle iki kez çalışır. JavaScript ve C++
zamanlama sonuçları 16 karşılaştırma senaryosunda aynı çıktı. Kartta çalışan
mevcut takvimin sahipliği/sürümü, bir zaman imleci ve iki geçmiş kaydı yükleme
sonrasında aynen korundu. Cron için cihazın `cron:true` yanıtı doğrulandı;
fiziksel kartta bir cron bildiriminin zamanında üretilmesi ayrıca test edilecek.

## 8. Ayarlanabilir OLED uyanma ve kapanma

- [x] Ekranı sürekli açık tutma seçeneği.
- [x] 1–1440 dakika boşta kapanma; sürenin yarısında kısılma.
- [x] Hatırlatmadan önce/sonra 0–1440 dakika açık kalma; varsayılan 10/10 dakika.
- [x] Sıfırla aralığı kapatma; yakın tekrarlar, erteleme, düzenleme ve iptal davranışı.
- [x] Bilgisayar ve bağımsız modda ayrı ekran ayarı aktarımı; sahiplik değişmez.
- [x] Kalıcı cihaz kaydı, yedekleme ve kayıt biçimi 6 → 7 öncesi geri dönüş yedeği.
- [x] Arayüzde aktarım, çevrimdışı ve eski firmware durumunu açıkça gösterme.
- [x] Uygulama, gerçek firmware API/politika testleri ve geniş/dar arayüz kontrolü.
- [x] Masa 0.8.0 macOS Apple Silicon paketinin derlenmesi ve imza/sürüm kontrolü.
- [x] Firmware 0.8.0 USB yüklemesi ve cihazda ayarların yeniden başlatma sonrası kalıcılığı.
- [x] Gerçek kartta varsayılanlar, ayar yazma/okuma, hatalı değer reddi ve takvimin korunması.

**Durum: yazılım, paket ve USB ayar doğrulaması tamamlandı (Masa/firmware 0.8.0).** Varsayılan 15:00
hatırlatması ekranı 14:50–15:10 açık tutar. Sürekli açık seçeneği zamanlı
aralıkları ve boşta kapanmayı geçersiz kılar. BOOT ve aktif bildirimler önceliklidir.

## Son doğrulama ve paket

- [x] 138 uygulama testi; eski kayıt geçişleri, takvim/DST, yedekleme, sahiplik,
      kaybolan yanıtlar ve çevrimdışı erteleme senaryoları.
- [x] Firmware derlemesi; OLED/düğme C++ testleri, takvim/atomik depolama ve
      gerçek firmware başlıklarıyla API testleri.
- [x] Gerçek motor ve HTTP simülatörüyle dar/geniş tarayıcı akışları; kaybolan
      kapatma yanıtı sonrası güvenli yeniden eşitleme.
- [x] tinyjs'in native çekirdeğinde cron/takvim, sessiz saatler, yedekleme ve sahiplik.
- [x] Masa 0.8.0 macOS Apple Silicon paketinin son kaynaklarla derlenmesi;
      paket sürümü ve imzasının doğrulanması.
- [x] Gerçek USB kartta yükleme, NTP, bağımsız takvim, yeniden başlatma ve
      uygulamayla devir/eşitleme. Ayrıntılar [donanım kaydında](hardware.md#usb-kart-doğrulaması--6-ekim-2026).

## Sıradaki işler

Yeni yazılım özelliği beklemiyor. Kalan işler fiziksel doğrulama ve paket
kullanım kontrolleridir; henüz yapılmayan kontroller tamamlandı sayılmaz.

1. Mevcut takvimi koruyarak ayrı fiziksel cron üretimi ve yeniden başlatma testi.
2. OLED'deki Türkçe test yazısı ve bağlı buzzerın melodisi için fiziksel onay.
   Test bildirimi gönderildi; kullanıcı gözlemi henüz alınmadı.
3. BOOT'un kısa/çift basış, 1–5 saniye erteleme ve 5 saniye kurulum hareketleri;
   erteleme ve tamamlanma olaylarının uygulamaya yalnızca bir kez aktarılması.
4. USB'yi çıkarıp takarak gerçek güç kesintisi; takvim/olayların korunması ve
   güvenilir saat alınana kadar zamanlamanın beklemesi. USB yazılım yeniden
   başlatması bu güç kesintisi testinin yerine geçmez.
5. Bilgisayar gerçekten kapalıyken ve ağ kesildiğinde cihazın çalışması;
   yeniden bağlanınca geçmiş ve eylemlerin doğru eşitlenmesi.
6. OLED'in sürekli açık seçeneği, ayarlanmış boşta kısılma/kapanma, BOOT ile
   uyanma ve gerçek hatırlatmanın 10 dakika öncesi/sonrası aralığı için görsel
   fiziksel kontrol. Sınırlar ve öncelikler C++ testlerinde, ayarların kalıcılığı
   gerçek kartta doğrulandı.
7. Derlenen macOS uygulamasının native penceresinde son kullanım kontrolü;
   diğer işletim sistemleri ve Intel Mac paketlerinin ayrıca derlenip denenmesi.

README ve protokol belgeleri güncel davranışı ve geçiş sınırlarını kaydeder.
