#include "oled_text.h"
#include "u8g2.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <string>

static uint8_t pixels[128 * 64];

// Capture real U8g2 font rendering instead of driving an I2C display.
extern "C" void u8g2_DrawHVLine(u8g2_t*, u8g2_uint_t x, u8g2_uint_t y, u8g2_uint_t length, uint8_t direction) {
  for (size_t i = 0; i < length; ++i) {
    const size_t px = x + (direction == 0 ? i : 0);
    const size_t py = y + (direction == 1 ? i : 0);
    assert(px >= 30 && px < 102 && py >= 12 && py < 52);
    pixels[py * 128 + px] = 1;
  }
}

int main() {
  const char* letters = "ÇçĞğİıÖöŞşÜü";
  const uint16_t encodings[] = {0xC7, 0xE7, 0x11E, 0x11F, 0x130, 0x131, 0xD6, 0xF6, 0x15E, 0x15F, 0xDC, 0xFC};
  const char* plain = "CcGgIiOoSsUu";
  assert(masa::characterCount(letters, strlen(letters)) == 12);
  for (size_t i = 0; i < 12; ++i) {
    const size_t offset = masa::characterOffset(letters, strlen(letters), i);
    const auto c = masa::nextCharacter(letters + offset, strlen(letters) - offset);
    assert(c.codepoint == encodings[i] && c.bytes == 2);
  }
  const std::string boundary = std::string(11, 'a') + "ş" + std::string(23, 'a') + "İç";
  assert(masa::characterCount(boundary.data(), boundary.size()) == 37);
  assert(masa::characterOffset(boundary.data(), boundary.size(), 12) == 13);
  assert(masa::characterOffset(boundary.data(), boundary.size(), 36) == 38);
  assert(boundary.substr(38) == "ç");
  assert(masa::pageCount(boundary.data(), boundary.size()) == 2);
  std::string longTitle;
  for (size_t i = 0; i < 80; ++i) longTitle += "ğ";
  assert(masa::pageCount(longTitle.data(), longTitle.size()) == 3);
  assert(masa::pageCount("", 0) == 1);
  assert(masa::characterOffset(letters, strlen(letters), 99) == strlen(letters));
  const auto emoji = masa::nextCharacter("🙂", strlen("🙂"));
  assert(emoji.codepoint == 0x1F642 && emoji.bytes == 4);
  for (const std::string invalid : {std::string("\xC0\xAF", 2), std::string("\xED\xA0\x80", 3), std::string("\xF0\x9F", 2)}) {
    assert(masa::nextCharacter(invalid.data(), invalid.size()).codepoint == 0xFFFD);
    assert(masa::characterCount(invalid.data(), invalid.size()) == invalid.size());
  }

  u8g2_t display = {};
  display.width = 128; display.height = 64;
  display.buf_y0 = 0; display.buf_y1 = 64;
  display.user_x0 = 30; display.user_x1 = 102;
  display.user_y0 = 12; display.user_y1 = 52;
  u8g2_SetFont(&display, MASA_OLED_FONT);
  u8g2_SetFontPosBaseline(&display);
  u8g2_SetFontMode(&display, 1);
  for (size_t i = 0; i < 12; ++i) {
    assert(u8g2_IsGlyph(&display, encodings[i]));
    assert(u8g2_GetGlyphWidth(&display, encodings[i]) == 6);
    memset(pixels, 0, sizeof pixels);
    assert(u8g2_DrawGlyph(&display, 30, 23, encodings[i]) == 6);
    uint8_t rendered[sizeof pixels]; memcpy(rendered, pixels, sizeof pixels);
    size_t filled = 0; for (auto pixel : pixels) filled += pixel;
    assert(filled > 0);
    memset(pixels, 0, sizeof pixels);
    u8g2_DrawGlyph(&display, 30, 23, plain[i]);
    assert(memcmp(pixels, rendered, sizeof pixels) != 0);
    // Every glyph also fits at the rightmost column of the last row.
    u8g2_DrawGlyph(&display, 96, 49, encodings[i]);
  }
  puts("PASS: Turkish glyphs render distinctly within 72x40; UTF-8 rows/pages, 80-character titles and malformed input are safe");
}
