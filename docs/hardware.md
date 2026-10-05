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
Ses ayrı bir görevde çalışır; yavaş bir ağ isteği notayı uzatmaz. BOOT’a kısa
basmak sesi kesip bildirimi kapatır. Sessiz seçenekte yalnızca ekran çalışır.
Aktif buzzer kendi sabit tonunu üretir; bu melodi için pasif buzzer gerekir.

U8g2 SSD1306 128×64 tamponu `(30,12)` başlangıcında 72×40 pencereye kırpılır.
SDA=5, SCL=6, I²C=0x3C. 6×10 yazıyla 12 karakter × 3 satır gösterilir;
sayfalar 3,5 saniyede değişir, bir bildirim en az 10 saniye görünür.

## İlk doğrulama

1. Buzzerı bağlamadan yazılımı yükle; [Wi-Fi kurulumunu](../README.md#esp32yi-hazırla) tamamla.
2. Masa’dan sessiz bir hatırlatıcı gönder; ekrandaki yazıyı kontrol et.
3. Gücü kes; MOSFET, dirençler, gerekliyse diyot, buzzer ve ortak GND’yi bağla.
4. Güç ver; Masa’daki **Test bildirimi** dört notayı çalar ve test metnini gösterir.
5. Seri monitörde `INFO` cihaz durumunu, `TEST` USB üzerinden aynı melodili testi başlatır.

USB’ye bağlı ESP32-C3 üzerinde yükleme ve çalışma günlüğü doğrulanabilir;
I²C adresinin yanıt vermesi ekrandaki görüntüyü, PWM görevinin tamamlanması ise
buzzerın fiziksel sesini doğrulamaz. Son ses kontrolünü bağlı buzzer ile yap.

Referanslar: [Kart incelemesi ve OLED örneği](https://emalliab.wordpress.com/2025/02/12/esp32-c3-0-42-oled/),
[kart şeması](https://github.com/zhuhai-esp/ESP32-C3-ABrobot-OLED),
[Espressif LEDC PWM belgeleri](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32c3/api-reference/peripherals/ledc.html),
[U8g2 sürücü belgeleri](https://github.com/olikraus/u8g2/wiki/u8g2setupcpp).
