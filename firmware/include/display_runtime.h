#pragma once
void sendDisplay(bool accepted=false) {
  DynamicJsonDocument document(1024);
  displayStateJson(document.to<JsonObject>(),displayState,false);
  document["protocol"]=4;if(accepted)document["accepted"]=true;
  String body;serializeJson(document,body);server.send(200,"application/json",body);
}
void getDisplay() {
  if(!authorize())return;if(!queueHealthy){reply(503,"Persistent state is corrupt");return;}sendDisplay();
}
void putDisplay() {
  if(!authorize())return;if(!queueHealthy){reply(503,"Persistent state is corrupt");return;}
  const String body=server.arg("plain");if(body.length()>2048){reply(413,"Display payload too large");return;}
  DynamicJsonDocument document(3072);masa::DisplaySettings settings;
  if(deserializeJson(document,body)||!parseDisplaySettings(document["settings"].as<JsonObject>(),settings)||!document.containsKey("nextDue")||!validMillis(document["nextDue"],true)||!validMillis(document["utcNow"])) {reply(400,"Invalid display settings");return;}
  const int64_t utc=document["utcNow"].as<int64_t>(),due=document["nextDue"]|int64_t(0);
  const auto old=displayState;displayState.settings=settings;masa::changeDisplayHint(displayState,due,utc);
  if(!(displayState==old)&&!saveQueue()){displayState=old;reply(507,"Display settings could not be persisted");return;}
  trustDesktopTime(utc);lastDraw=0;sendDisplay(true);
}
bool displayWindowActive(int64_t utc) {
  const auto& settings=displayState.settings;
  if(masa::displayAfter(settings,displayState.lastNoticeAt,utc))return true;
  if(autonomous.enabled) {
    for(const auto& r:autonomous.reminders)if(r.enabled&&masa::displayAround(settings,r.nextDue,utc))return true;
    for(const auto& job:autonomous.deferred)if(masa::displayAround(settings,job.due,utc))return true;
    for(const auto& job:autonomous.history)if(scheduledReminder(autonomous,job.reminderId)&&masa::displayAfter(settings,job.due,utc))return true;
    return false;
  }
  return masa::displayAround(settings,displayState.nextDue,utc)||masa::displayAfter(settings,displayState.previousDue,utc);
}
unsigned idleDisplayContrast(uint32_t now) {
  const bool trusted=clockTrusted.load();
  return masa::displayContrast(displayState.settings,now,idleState.awakeSince,trusted,trusted&&displayWindowActive(utcMillis()));
}
