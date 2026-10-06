# 5 V pasif buzzer bağlantısı

Hedef: ABRobot ESP32-C3 0.42 OLED (USB Type-C). Ekran GPIO5/GPIO6’yı kullanır.
Varsayılan buzzer kontrolü **GPIO3**, bildirim kapatma düğmesi **GPIO9 / BOOT**.
Bu bağlantı iki bacaklı, harici osilatör gerektiren **pasif** buzzer içindir.

## Gerekli parçalar

- 5 V pasif buzzer; piezo veya elektromanyetik tipini ve akımını ürününden kontrol et.
- 2,5–3,3 V gate geriliminde düşük RDS(on) belirtilen N-kanal MOSFET
  (örn. [AO3400A](https://www.aosmd.com/sites/default/files/res/datasheets/AO3400A.pdf);
  parçanın bacak sırasını veri sayfasından doğrula).
- Gate için 100 Ω seri direnç ve gate–GND için 100 kΩ pulldown.
- Buzzer uçlarına paralel 1 kΩ / ¼ W direnç: MOSFET kapandığında piezonun
  yükünü boşaltır; elektromanyetik tipte de kullanılabilir.
- Elektromanyetik buzzer için ters paralel diyot (örn. 1N5819, akıma uygun seç).
  Piezo buzzer için diyot gerekmez.
- Buzzer akımına uygun 5 V besleme; yakınında 100 nF seramik bypass kapasitörü.

## Bağlantı

```text
                              +5 V
                                |
                     +----------+----------+
                     |          |          |
                 BUZZER (+)   [1 kΩ]    DIYOT katot
                 BUZZER (-)     |       DIYOT anot
                     |          |          |
                     +----------+----------+
                                |
                          MOSFET drain
ESP32 GPIO3 -- 100 Ω -- MOSFET gate
                         |
                       100 kΩ
                         |
ESP32 GND ---------------+--- MOSFET source --- 5 V beslemesi GND
```

Diyot yalnızca elektromanyetik tipte gereklidir; çizgili katodu +5 V’a bağlanır.
**5 V buzzer doğrudan GPIO’ya bağlanmaz.** GPIO3, MOSFET üzerinden 3,3 V kontrol
sinyali üretir; buzzer 5 V ile beslenir. USB-C kartı besleyebilir. Buzzer için ayrı,
ayarlı 5 V kaynak kullan ve GND’leri birleştir; harici 5 V’u kartın USB/3V3 hattına
verme. Üç bacaklı sürücü modülü kullanıyorsan girişinin 3,3 V uyumluluğunu ayrıca doğrula.

`BUZZER_PIN` değiştirirken OLED 5/6, BOOT 9, LED/strap 8, strap 2, USB 18/19
ve dahili flash pinlerini kullanma. Eski yerel `config.h` içindeki `MOTOR_PIN`
geçici olarak aynı kontrol pinine eşlenir; yeni ayar adı `BUZZER_PIN`’dir.

## Melodi ve ekran

Firmware PWM ile C6–E6–G6–C7 notalarını çalar: 1047, 1319, 1568 ve 2093 Hz;
nota süreleri 140/140/140/260 ms, aralar 50 ms. Toplam yaklaşık **0,9 saniye**.
Ses ayrı bir görevde çalışır; yavaş bir ağ isteği notayı uzatmaz. BOOT'a basmak
sesi keser. Kısa basış, ikinci basış için yaklaşık 350 ms bekledikten sonra
bildirimi kapatır. Firmware 0.6.0'da çift basış işi tamamlandı olarak işaretler;
1–5 saniye basıp bırakmak 15 dakika erteleme oluşturur. 5 saniye tutmak yalnızca
Wi-Fi kurulumunu açar. Bildirim, hareket sonuçlanana kadar otomatik kapanmaz.
İşlemler kalıcı kuyruğa yazılır; kaydedilemezse not kapanmaz ve uyarı gösterilir.
Bilgisayar modunda erteleme süresi Masa işlemi aldığında başlar; bağımsız modda
15 dakika cihazda hemen başlatılır ve bilgisayar kapalıyken de yürür. Düğme
eylemleri, kuyruk ve takvim aynı atomik kayıtta saklanır. Bu akışın yazılım
kontrolleri geçti; fiziksel kart ve güç kesintisi testi bekliyor.
Sessiz bildirimde ve ayarlanan sessiz saatlerde yalnızca ekran çalışır.
Aktif buzzer kendi sabit tonunu üretir; bu melodi için pasif buzzer gerekir.

U8g2 SSD1306 128×64 tamponu `(30,12)` başlangıcında 72×40 pencereye kırpılır.
SDA=5, SCL=6, I²C=0x3C. Türkçe harfleri içeren `u8g2_font_6x12_te` yazı tipiyle 12 karakter × 3 satır gösterilir;
sayfalar 3,5 saniyede değişir, bir bildirim en az 10 saniye görünür. Metinler UTF-8
olarak çizilir; `ç Ç ğ Ğ ı İ ö Ö ş Ş ü Ü` korunur. Satır ve sayfa sınırları bayt
sayısına göre bölünmez. Yazı tipinde olmayan karakterler yalnızca görüntülemede
`?` olur; orijinal başlık cihaz kuyruğunda korunur.

Bildirim bulunmadığında saat, sıradaki not ve kalan süre 5 saniyede bir değişir.
Boşta ekran 60 saniyede kısılır, 120 saniyede kapanır; BOOT veya yeni bildirim
uyandırır. Boş ekranda BOOT'a basmak tamamlandı ya da erteleme oluşturmaz.
Saat eşitlenmemişse cihaz bekleme durumunu gösterir.

## Bağımsız çalışma ve yeniden başlama

Masa 0.6.0'da **Takvimi cihazda çalıştır** seçeneği, firmware 0.6.0 / protokol 4
cihazına en fazla 24 hatırlatıcı ve 24 erteleme aktarır. Cihazın açık kalması
yeterlidir; takvim onaylandıktan sonra bilgisayar kapanabilir. Ağ kopması çalışan
saati durdurmaz. Güç kesilip cihaz yeniden açılırsa önce NTP veya Masa'nın UTC
aktarımıyla güvenilir saat alınır; saat hazır olana kadar yeni hatırlatma üretilmez.

Takvim, kuyruk ve düğme olayları LittleFS'de `/masa-state.json` dosyasında atomik
olarak saklanır. Wi-Fi `/wifi.json` ve cihaz anahtarı korunur. Boş dosya sistemi
bölümü ilk kurulumda hazırlanabilir; mevcut Wi-Fi verisi olan bölüm otomatik
biçimlendirilmez. Normal firmware yüklemesinde `uploadfs` kullanma.

Korunan eski NVS kaydı geri dönüş için saklanır; yeni işlemlerle güncellenmez.
Eski firmware'e dönmeden önce bağımsız modu kapatıp bilgisayara devri onaylat,
kuyruk ve olayları boşalt ve Masa yedeği al. Eski NVS'deki notlar yeniden
görüntülenebilir; yeni kaydın eski sürüm tarafından okunacağını varsayma.

## İlk doğrulama

1. Buzzerı bağlamadan yazılımı yükle; [Wi-Fi kurulumunu](../README.md#kurulum) tamamla.
2. Masa’dan sessiz bir hatırlatıcı gönder; ekrandaki yazıyı kontrol et.
3. Gücü kes; MOSFET, dirençler, gerekliyse diyot, buzzer ve ortak GND’yi bağla.
4. Güç ver; Masa’daki **Test bildirimi** dört notayı çalar ve test metnini gösterir.
5. Seri monitörde `INFO` cihaz durumunu, `TEST` USB üzerinden Türkçe harfleri içeren melodili testi başlatır;
   `Çç Ğğ İı Öö Şş Üü Türkçe testi` metnini kontrol et.
6. Takvimi cihaza aktarıp bilgisayarı kapat; hatırlatma, çift basış ve cihazda
   15 dakika ertelemeyi doğrula. Sonra Masa'yı açıp geçmişi eşitle.
7. Gerçek OLED'de boşta 5 saniyelik bilgi değişimini, 60 saniyede kısılmayı,
   120 saniyede kapanmayı ve BOOT ile uyanmayı kontrol et.
8. Gücü kesip yeniden ver; güvenilir saat gelmeden bildirim üretilmediğini,
   NTP veya Masa ile eşitlemeden sonra takvim ve düğme olaylarının korunduğunu doğrula.

USB’ye bağlı ESP32-C3 üzerinde yükleme ve çalışma günlüğü doğrulanabilir;
I²C adresinin yanıt vermesi ekrandaki görüntüyü, PWM görevinin tamamlanması ise
buzzerın fiziksel sesini doğrulamaz. Son ses kontrolünü bağlı buzzer ile yap.
Firmware 0.6.0 için bu fiziksel kart, OLED, düğme, gerçek NTP ve güç kesintisi
adımları henüz tamamlanmış sayılmıyor; otomatik ve simülatör testleri ayrı kanıttır.

Referanslar: [Kart incelemesi ve OLED örneği](https://emalliab.wordpress.com/2025/02/12/esp32-c3-0-42-oled/),
[kart şeması](https://github.com/zhuhai-esp/ESP32-C3-ABrobot-OLED),
[Espressif LEDC PWM belgeleri](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32c3/api-reference/peripherals/ledc.html),
[U8g2 sürücü belgeleri](https://github.com/olikraus/u8g2/wiki/u8g2setupcpp).

## USB kart doğrulaması — 6 Ekim 2026

USB'de ESP32-C3 rev. 0.4 kart üzerinde firmware 0.2.3 → 0.6.0 güncellemesi
uygulandı. Yüklemeden önce 4 MB flash yedeği özel, Git dışında tutulan
`.build/device-backups/` klasörüne alındı; dosya sistemi yüklenmedi.

Doğrulananlar:

- Firmware 0.6.0 / protokol 4 açılışı, mevcut Wi-Fi ve cihaz anahtarının korunması.
- Gerçek kartta NTP ile saatin hazır hâle gelmesi; açılışın hemen sonrasında
  `timeValid:false`, eşitlemeden sonra `true` yanıtı.
- Uygulama `/api/notify` göndermeden, karta aktarılan tek seferlik takvimin bir
  bildirim üretmesi ve sonraki zamanın `null` olması; yinelenen üretim olmaması.
- USB üzerinden yeniden başlatma sonrası takvim sürümü ve teslimat geçmişinin korunması.
- Masa motorunun gerçek HTTP bağlantısıyla takvimi devralması, bağımsız üretilen
  kaydı geçmişe indirmesi, tamamlandı işlemini karta aktarması ve takvimi
  bilgisayara geri devretmesi. Geçici test hatırlatıcıları kaldırıldı.
- OLED'in I²C adresinde bulunması, ses görevinin hazır olması ve Türkçe test
  bildiriminin cihaz tarafından kabul edilmesi.

Test takvimi sonunda kapatıldı. I²C yanıtı ve ses görevinin hazır olması,
ekrandaki görüntü veya buzzerın duyulan sesi için fiziksel onay yerine geçmez.
Fiziksel düğme hareketleri, USB'yi çekerek güç kesintisi, ağ kesintisi ve
bilgisayarın gerçekten kapalı olduğu senaryo ayrıca doğrulanmalıdır.


### Cron güncellemesi için yedek

Firmware 0.7.0 yüklemesi öncesinde kartın 4 MB flash yedeği alındı ve SHA-256
bütünlük kontrolü geçti. Bu yedek özel, Git dışında tutulan
`~/Library/Application Support/Masa/device-backups/` klasöründedir. Kalıcı
donanım yedeklerini `.build/` altında tutma; bu klasör masaüstü derlemesi
sırasında temizlenebilir.

Yedek öncesindeki kontrolde firmware 0.6.0, bir etkin takvim ve iki geçmiş
kaydı vardı. Firmware 0.7.0 yüklendi; `protocol:4`, `cron:true`, NTP ile
`timeValid:true` ve aynı anahtarla HTTP bağlantısı doğrulandı. Takvim sahibi,
sürümü, etkinliği, zaman imleci, iki geçmiş kaydı ve boş erteleme listesi
birebir korundu. Mevcut takvim değiştirilmedi. Cron yazılımı, C++ API testleri
ve 16 JavaScript/C++ zamanlama karşılaştırması geçti; bağımsız cron üretimi
fiziksel kart üzerinde ayrıca doğrulanacak.

Bu kartta standart yükleme yardımcı programı başlatıldıktan sonra USB yanıtı
kesildi. `esptool --no-stub` ile yalnızca uygulama alanına yükleme tamamlandı
ve yazılan verinin hash kontrolü geçti. Bu alternatif, aynı derlemenin
`firmware.bin` dosyasını `0x10000` adresine yazar; dosya sistemi, NVS,
bootloader ve bölüm tablosu korunur. Bölüm düzeni farklı bir projede adresi
ayrıca doğrula.
