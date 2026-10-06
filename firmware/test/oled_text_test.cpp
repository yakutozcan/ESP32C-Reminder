#include "oled_text.h"
#include "u8g2.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>

static uint8_t pixels[128 * 64];

// Capture real U8g2 font rendering instead of driving an I2C display.
extern "C" void u8g2_DrawHVLine(u8g2_t*, u8g2_uint_t x, u8g2_uint_t y, u8g2_uint_t length, uint8_t direction) {
  for (size_t i = 0; i < length; ++i) {
    const size_t px = x + (direction == 0 ? i : 0);
    const size_t py = y + (direction == 1 ? i : 0);
    assert(px < 128 && py < 64);
    pixels[py * 128 + px] = 1;
  }
}

static std::vector<uint8_t> commands;
static uint8_t captureCommands(u8x8_t*, uint8_t msg, uint8_t value, void*) {
  if(msg==U8X8_MSG_CAD_SEND_CMD || msg==U8X8_MSG_CAD_SEND_ARG) commands.push_back(value);
  return 1;
}
static bool hasCommand(uint8_t command,uint8_t argument) {
  for(size_t i=1;i<commands.size();++i)
    if(commands[i-1]==command && commands[i]==argument)return true;
  return false;
}
static unsigned render(u8g2_t& display,const char* text,unsigned x,unsigned y) {
  memset(pixels,0,sizeof pixels);
  for(const char* c=text;*c;++c)x+=u8g2_DrawGlyph(&display,x,y,*c);
  unsigned count=0;for(auto pixel:pixels)count+=pixel;
  return count;
}

int main() {
  // Exercise the panel driver: a 64-row multiplex cannot model this 40-row panel.
  u8x8_t panel={};panel.cad_cb=captureCommands;panel.gpio_and_delay_cb=captureCommands;
  u8x8_d_ssd1306_72x40_er(&panel,U8X8_MSG_DISPLAY_SETUP_MEMORY,0,nullptr);
  assert(panel.display_info->pixel_width==masa::OLED_WIDTH);
  assert(panel.display_info->pixel_height==masa::OLED_HEIGHT);
  u8x8_d_ssd1306_72x40_er(&panel,U8X8_MSG_DISPLAY_INIT,0,nullptr);
  assert(hasCommand(0xA8,39) && hasCommand(0xD3,0));
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
  display.width = masa::OLED_WIDTH; display.height = masa::OLED_HEIGHT;
  display.buf_y0 = 0; display.buf_y1 = masa::OLED_HEIGHT;
  display.user_x0 = 0; display.user_x1 = masa::OLED_WIDTH;
  display.user_y0 = 0; display.user_y1 = masa::OLED_HEIGHT;
  u8g2_SetFont(&display, MASA_OLED_FONT);
  u8g2_SetFontPosBaseline(&display);
  u8g2_SetFontMode(&display, 1);
  for (size_t i = 0; i < 12; ++i) {
    assert(u8g2_IsGlyph(&display, encodings[i]));
    assert(u8g2_GetGlyphWidth(&display, encodings[i]) == 6);
    memset(pixels, 0, sizeof pixels);
    assert(u8g2_DrawGlyph(&display, 0, 11, encodings[i]) == 6);
    uint8_t rendered[sizeof pixels]; memcpy(rendered, pixels, sizeof pixels);
    size_t filled = 0; for (auto pixel : pixels) filled += pixel;
    assert(filled > 0);
    memset(pixels, 0, sizeof pixels);
    u8g2_DrawGlyph(&display, 0, 11, plain[i]);
    assert(memcmp(pixels, rendered, sizeof pixels) != 0);
    // Every glyph also fits at the rightmost column of the last row.
    u8g2_DrawGlyph(&display, 66, 37, encodings[i]);
  }
  // Compare all 1,440 times to an unclipped reference: bounds alone miss lost pixels.
  u8g2_t reference=display;
  reference.width=128;reference.height=64;reference.buf_y1=64;
  reference.user_x1=128;reference.user_y1=64;
  for(unsigned minute=0;minute<24*60;++minute) {
    char text[6];snprintf(text,sizeof text,"%02u:%02u",minute/60,minute%60);
    u8g2_SetFont(&display,MASA_OLED_CLOCK_FONT);
    u8g2_SetFont(&reference,MASA_OLED_CLOCK_FONT);
    unsigned width=0;for(const char* c=text;*c;++c)width+=u8g2_GetGlyphWidth(&display,*c);
    assert(width<=masa::OLED_WIDTH);
    const auto expected=render(reference,text,30,40);
    assert(render(display,text,(masa::OLED_WIDTH-width)/2,masa::OLED_CLOCK_BASELINE)==expected);
    for(unsigned y=0;y<64;++y)for(unsigned x=0;x<128;++x)
      if(pixels[y*128+x])assert(x<masa::OLED_WIDTH && y>=6 && y<=masa::OLED_CLOCK_BASELINE);
  }
  u8g2_SetFont(&display,MASA_OLED_FONT);u8g2_SetFont(&reference,MASA_OLED_FONT);
  const char* date="06.10.2026";
  const auto datePixels=render(reference,date,30,40);
  assert(render(display,date,6,masa::OLED_DATE_BASELINE)==datePixels);
  puts("PASS: native 72x40 panel initialization, all 1,440 unclipped times, Turkish glyphs and UTF-8 pagination");
}
