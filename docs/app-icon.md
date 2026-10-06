# Masa uygulama ikonu

Krem gövdeli küçük masa saati, koyu yeşil zemin ve kehribar hatırlatma ışığı,
uygulamanın renklerini ve OLED hatırlatıcı fikrini birleştirir. Yazı içermez;
küçük boyutta saat silueti okunabilir kalır. Karenin dışı şeffaftır.

Kaynak: [`icon.png`](../icon.png), 1024 × 1024 RGBA. Masa 0.8.1 ile kullanılır.
`tinyjs.json` içindeki `icon` alanı bu dosyayı seçer. `tinyjs build`, 16–1024
piksel macOS temsillerini üretip `Contents/Resources/AppIcon.icns` içine koyar;
`Info.plist` bu kaynağı uygulama ikonu olarak tanımlar.

6 Ekim 2026'da yerleşik imagegen aracıyla üretildi. Üretilen PNG yalnızca
`sips` ile paketlemenin 1024 piksel kaynak boyutuna ölçeklendi; şeffaflık korundu.

## Üretim istemi

```text
Use case: logo-brand. Asset type: final macOS application icon for 'Masa', a calm personal reminder app connected to a tiny OLED desk device. Create one polished square 1024x1024 icon, not a presentation or mockup. Transparent outer canvas. A centered deep forest-green rounded-square app tile occupies about 82% of the canvas, with macOS-style generous rounded corners and subtle crafted depth. On the tile, a single bold miniature desk reminder device: warm ivory ceramic enclosure, front-facing with very slight dimensional depth, one dark OLED display containing a simple large ivory clock dial with only two hands and no numerals. A tiny warm amber reminder indicator at the upper-right corner of the device. Device stands on a short clean ivory foot. Quiet, tactile, editorial design, matching an ivory and forest-green desk journal interface. Strong silhouette, broad shapes readable at 32 pixels, carefully balanced spacing, soft studio highlights, restrained shadow. Device occupies most of the tile center. No text, no letters, no numerals, no complex circuit details, no extra objects, no watermarks. Actual transparent pixels outside the tile and its restrained shadow. Return only the finished icon asset.
```
