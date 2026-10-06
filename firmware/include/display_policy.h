#pragma once
#include <stdint.h>
namespace masa {
struct DisplaySettings {
  bool alwaysOn=false;
  uint16_t sleepMinutes=2,wakeBeforeMinutes=10,wakeAfterMinutes=10;
  bool operator==(const DisplaySettings& other) const {
    return alwaysOn==other.alwaysOn&&sleepMinutes==other.sleepMinutes&&wakeBeforeMinutes==other.wakeBeforeMinutes&&wakeAfterMinutes==other.wakeAfterMinutes;
  }
};
struct DisplayState {
  DisplaySettings settings;
  int64_t nextDue=0,previousDue=0,lastNoticeAt=0;
  bool operator==(const DisplayState& other) const {
    return settings==other.settings&&nextDue==other.nextDue&&previousDue==other.previousDue&&lastNoticeAt==other.lastNoticeAt;
  }
};
inline bool displayBefore(const DisplaySettings& settings,int64_t due,int64_t now) {
  return due>0&&settings.wakeBeforeMinutes>0&&now>=due-int64_t(settings.wakeBeforeMinutes)*60000&&now<due;
}
inline bool displayAfter(const DisplaySettings& settings,int64_t due,int64_t now) {
  return due>0&&settings.wakeAfterMinutes>0&&now>=due&&now<due+int64_t(settings.wakeAfterMinutes)*60000;
}
inline bool displayAround(const DisplaySettings& settings,int64_t due,int64_t now) {
  return displayBefore(settings,due,now)||displayAfter(settings,due,now);
}
inline void changeDisplayHint(DisplayState& state,int64_t due,int64_t now) {
  if(due==state.nextDue)return;
  // Future hints removed/paused before they fire must stop waking the OLED.
  // The most recent elapsed hint keeps its post-window after the next due moves.
  if(state.nextDue>0&&state.nextDue<=now&&state.nextDue>state.previousDue)state.previousDue=state.nextDue;
  state.nextDue=due;
}
inline unsigned displayContrast(const DisplaySettings& settings,uint32_t now,uint32_t awakeSince,bool trusted,bool window,bool priority=false) {
  if(priority||settings.alwaysOn||(trusted&&window))return 180;
  const uint32_t sleep=uint32_t(settings.sleepMinutes)*60000;
  const uint32_t elapsed=now-awakeSince;
  return elapsed>=sleep?0:elapsed>=sleep/2?40:180;
}
}
