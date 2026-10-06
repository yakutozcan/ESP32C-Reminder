#pragma once
#include <stddef.h>
#include <stdint.h>
#define MASA_OLED_FONT u8g2_font_6x12_te
#define MASA_OLED_CLOCK_FONT u8g2_font_logisoso18_tn

namespace masa {
constexpr unsigned OLED_WIDTH = 72;
constexpr unsigned OLED_HEIGHT = 40;
constexpr unsigned OLED_CLOCK_BASELINE = 25;
constexpr unsigned OLED_DATE_BASELINE = 37;
constexpr size_t OLED_COLUMNS = 12;
constexpr size_t OLED_ROWS = 3;
constexpr size_t OLED_PAGE_CHARACTERS = OLED_COLUMNS * OLED_ROWS;

struct Utf8Character { uint32_t codepoint; size_t bytes; };

// Invalid bytes consume one position and are rendered as '?' by the caller.
inline Utf8Character nextCharacter(const char* text, size_t remaining) {
  if (!remaining) return {0, 0};
  const auto* bytes = reinterpret_cast<const unsigned char*>(text);
  const uint8_t first = bytes[0];
  if (first < 0x80) return {first, 1};
  const size_t length = first >= 0xC2 && first <= 0xDF ? 2 :
                        first >= 0xE0 && first <= 0xEF ? 3 :
                        first >= 0xF0 && first <= 0xF4 ? 4 : 0;
  if (!length || length > remaining) return {0xFFFD, 1};
  uint32_t codepoint = first & (0x7F >> length);
  for (size_t i = 1; i < length; ++i) {
    if ((bytes[i] & 0xC0) != 0x80) return {0xFFFD, 1};
    codepoint = (codepoint << 6) | (bytes[i] & 0x3F);
  }
  if ((length == 3 && codepoint < 0x800) || (length == 4 && codepoint < 0x10000) ||
      (codepoint >= 0xD800 && codepoint <= 0xDFFF) || codepoint > 0x10FFFF) return {0xFFFD, 1};
  return {codepoint, length};
}

inline size_t characterCount(const char* text, size_t length) {
  size_t count = 0;
  for (size_t offset = 0; offset < length; ++count)
    offset += nextCharacter(text + offset, length - offset).bytes;
  return count;
}

inline size_t characterOffset(const char* text, size_t length, size_t position) {
  size_t offset = 0;
  while (position-- && offset < length)
    offset += nextCharacter(text + offset, length - offset).bytes;
  return offset;
}

inline size_t pageCount(const char* text, size_t length) {
  const size_t count = characterCount(text, length);
  return count ? (count + OLED_PAGE_CHARACTERS - 1) / OLED_PAGE_CHARACTERS : 1;
}
} // namespace masa
