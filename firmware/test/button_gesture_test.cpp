#include "button_gesture.h"
#include <assert.h>
#include <stdio.h>
#include <initializer_list>
using masa::ButtonAction;
using masa::ButtonGesture;

static void press(ButtonGesture& button, uint32_t now) {
  assert(button.update(true, now) == ButtonAction::None);
  assert(button.update(true, now + 40) == ButtonAction::None);
}
static ButtonAction release(ButtonGesture& button, uint32_t now) {
  assert(button.update(false, now) == ButtonAction::None);
  return button.update(false, now + 40);
}
int main() {
  {
    ButtonGesture button;
    // Bounce shorter than 40ms does not make a click.
    button.update(true, 100); button.update(false, 120);
    assert(button.update(false, 500) == ButtonAction::None);
    assert(!button.busy());
    press(button, 600);
    assert(release(button, 700) == ButtonAction::None);
    assert(button.busy());
    assert(button.update(false, 1089) == ButtonAction::None);
    assert(button.update(false, 1090) == ButtonAction::Dismiss);
    assert(!button.busy());
    assert(button.update(false, 2000) == ButtonAction::None);
  }
  {
    ButtonGesture button;
    press(button, 100); assert(release(button, 200) == ButtonAction::None);
    press(button, 350);
    assert(release(button, 450) == ButtonAction::Complete);
    assert(button.update(false, 1000) == ButtonAction::None);
  }
  for (uint32_t offset : {uint32_t(0), uint32_t(0xFFFFFE00)}) {
    ButtonGesture button;
    press(button, offset + 100);
    assert(release(button, offset + 1200) == ButtonAction::Snooze);
    assert(button.update(false, offset + 5000) == ButtonAction::None);
  }
  {
    ButtonGesture button;
    press(button, 100);
    assert(button.update(true, 5139) == ButtonAction::None);
    assert(button.update(true, 5140) == ButtonAction::Setup);
    assert(button.update(true, 10000) == ButtonAction::None);
    assert(release(button, 10100) == ButtonAction::None);
    assert(button.update(false, 11000) == ButtonAction::None);
  }
  {
    ButtonGesture button;
    press(button, 100); assert(release(button, 200) == ButtonAction::None);
    press(button, 300);
    assert(release(button, 1500) == ButtonAction::Snooze); // second press held
    assert(button.update(false, 2000) == ButtonAction::None);
  }
  {
    ButtonGesture button;
    // Second press starts at the boundary before debounce settles.
    press(button, 100); assert(release(button, 200) == ButtonAction::None);
    press(button, 590);
    assert(release(button, 700) == ButtonAction::Complete);
  }
  puts("PASS: single/double/hold gestures, debounce, setup exclusivity and millis rollover");
}
