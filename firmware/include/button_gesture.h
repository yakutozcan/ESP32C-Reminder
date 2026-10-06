#pragma once
#include <stdint.h>

namespace masa {
enum class ButtonAction { None, Dismiss, Complete, Snooze, Setup };

// Hardware-independent, wrap-safe debounce and gesture classification.
class ButtonGesture {
 public:
  bool busy() const { return rawDown || down || waiting; }
  ButtonAction update(bool raw, uint32_t now) {
    if (raw != rawDown) { rawDown = raw; changedAt = now; }
    if (rawDown != down && uint32_t(now - changedAt) >= 40) {
      down = rawDown;
      if (down) {
        second = waiting && uint32_t(changedAt - releasedAt) <= 350;
        waiting = false; held = false; pressedAt = now;
      } else if (held) {
        held = false; second = false;
      } else if (uint32_t(now - pressedAt) >= 1000) {
        second = false; return ButtonAction::Snooze;
      } else if (second) {
        second = false; return ButtonAction::Complete;
      } else {
        waiting = true; releasedAt = now;
      }
    }
    if (down && !held && uint32_t(now - pressedAt) >= 5000) {
      held = true; waiting = false; second = false; return ButtonAction::Setup;
    }
    if (waiting && !rawDown && !down && uint32_t(now - releasedAt) >= 350) {
      waiting = false; return ButtonAction::Dismiss;
    }
    return ButtonAction::None;
  }
 private:
  bool rawDown = false, down = false, waiting = false, second = false, held = false;
  uint32_t changedAt = 0, pressedAt = 0, releasedAt = 0;
};
}
