#pragma once
#include "display_policy.h"
masa::DisplayState displayState;
void displaySettingsJson(JsonObject object,const masa::DisplaySettings& settings) {
  object["alwaysOn"]=settings.alwaysOn;object["sleepMinutes"]=settings.sleepMinutes;
  object["wakeBeforeMinutes"]=settings.wakeBeforeMinutes;object["wakeAfterMinutes"]=settings.wakeAfterMinutes;
}
bool parseDisplaySettings(JsonObject object,masa::DisplaySettings& settings) {
  if(!object["alwaysOn"].is<bool>()||!object["sleepMinutes"].is<int>()||!object["wakeBeforeMinutes"].is<int>()||!object["wakeAfterMinutes"].is<int>())return false;
  const int sleep=object["sleepMinutes"].as<int>(),before=object["wakeBeforeMinutes"].as<int>(),after=object["wakeAfterMinutes"].as<int>();
  if(sleep<1||sleep>1440||before<0||before>1440||after<0||after>1440)return false;
  settings.alwaysOn=object["alwaysOn"].as<bool>();settings.sleepMinutes=sleep;settings.wakeBeforeMinutes=before;settings.wakeAfterMinutes=after;return true;
}
void displayStateJson(JsonObject object,const masa::DisplayState& state,bool storage) {
  displaySettingsJson(object.createNestedObject("settings"),state.settings);
  if(state.nextDue)object["nextDue"]=state.nextDue;else object["nextDue"]=nullptr;
  if(storage){if(state.previousDue)object["previousDue"]=state.previousDue;else object["previousDue"]=nullptr;if(state.lastNoticeAt)object["lastNoticeAt"]=state.lastNoticeAt;else object["lastNoticeAt"]=nullptr;}
}
bool parseStoredDisplay(JsonVariant stored,masa::DisplayState& state) {
  state=masa::DisplayState{};
  // Firmware <=0.7 snapshots have no display section. Preserve queues/schedules
  // and initialize the documented defaults when loading that legacy snapshot.
  if(stored.isNull())return true;
  if(!stored.is<JsonObject>())return false;
  JsonObject object=stored.as<JsonObject>();
  if(!parseDisplaySettings(object["settings"].as<JsonObject>(),state.settings)||!object.containsKey("nextDue")||!validMillis(object["nextDue"],true))return false;
  state.nextDue=object["nextDue"]|int64_t(0);
  for(const char* key:{"previousDue","lastNoticeAt"})if(object.containsKey(key)&&!validMillis(object[key],true))return false;
  state.previousDue=object["previousDue"]|int64_t(0);state.lastNoticeAt=object["lastNoticeAt"]|int64_t(0);return true;
}
void markDisplayNotice() {if(clockTrusted)displayState.lastNoticeAt=utcMillis();}
