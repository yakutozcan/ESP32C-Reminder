#pragma once
AutonomousJob* historyJob(const String& id) {for(auto& job:autonomous.history)if(job.id==id)return &job;return nullptr;}
bool scheduledReminder(const AutonomousState& state,const String& id) {for(const auto& r:state.reminders)if(r.id==id)return r.enabled;return false;}
String fingerprintState(const AutonomousState& state) {
  uint64_t hash=14695981039346656037ULL;
  auto add=[&](const String& text){for(size_t i=0;i<text.length();++i){hash^=uint8_t(text[i]);hash*=1099511628211ULL;}hash^=255;hash*=1099511628211ULL;};
  add(state.ownerId);add(state.timezone);add(String(state.enabled));add(String(state.quietEnabled));add(String(state.quietStart));add(String(state.quietEnd));
  for(const auto& reminder:state.reminders)add(reminder.config);
  for(const auto& root:state.completedRoots)add(root);
  add("cancelled");for(const auto& id:state.cancelledIds)add(id);
  char text[17];snprintf(text,sizeof(text),"%016llx",(unsigned long long)hash);return String(text);
}
void sendSchedule(bool accepted=false) {
  DynamicJsonDocument doc(49152);stateJson(doc.to<JsonObject>(),autonomous,false);if(accepted)doc["accepted"]=true;
  if(doc.overflowed()){reply(507,"Schedule serialization failed");return;}
  String response;serializeJson(doc,response);server.send(200,"application/json",response);
}
void getSchedule() {if(!authorize())return;if(!queueHealthy){reply(503,"Persistent state is corrupt");return;}sendSchedule();}
void trustDesktopTime(int64_t now) {timeval time{};time.tv_sec=now/1000;time.tv_usec=(now%1000)*1000;if(settimeofday(&time,nullptr)==0)clockTrusted=true;}
#include "display_runtime.h"
void putSchedule() {
  if(!authorize())return;
  if(!queueHealthy){reply(503,"Persistent state is corrupt");return;}
  String body=server.arg("plain");if(body.length()>32768){reply(413,"Schedule payload too large");return;}
  AutonomousState incoming;int64_t suppliedTime=0;bool takeover=false;
  {
    DynamicJsonDocument doc(49152);
    if(deserializeJson(doc,body)||!validMillis(doc["utcNow"])||!parseState(doc.as<JsonObject>(),incoming)){reply(400,"Invalid schedule or capacity exceeded");return;}
    suppliedTime=doc["utcNow"].as<int64_t>();takeover=doc["takeover"]|false;
    incoming.fingerprint=fingerprintState(incoming);
  }
  body=String();
  const bool sameOwner=incoming.ownerId==autonomous.ownerId;
  if(autonomous.enabled&&!sameOwner&&!takeover){reply(409,"Another desktop owns this schedule; explicit takeover required");return;}
  if(sameOwner&&incoming.revision<autonomous.revision){reply(409,"Schedule revision is stale");return;}
  if(sameOwner&&incoming.revision==autonomous.revision){
    if(incoming.fingerprint!=autonomous.fingerprint){reply(409,"Revision already has different content");return;}
    trustDesktopTime(suppliedTime);sendSchedule(true);return;
  }
  if(sameOwner&&incoming.timezone==autonomous.timezone)for(auto& r:incoming.reminders)for(const auto& old:autonomous.reminders)if(old.id==r.id&&old.config==r.config)r.nextDue=old.nextDue;
  incoming.history=autonomous.history;
  auto tombstoned=[&](const AutonomousJob& job){for(const auto& root:incoming.completedRoots)if(root==job.rootId)return true;for(const auto& id:incoming.cancelledIds)if(id==job.id)return true;return false;};
  auto changedReminder=[&](const String& id){
    for(const auto& next:incoming.reminders)if(next.id==id){if(!next.enabled)return true;for(const auto& old:autonomous.reminders)if(old.id==id)return next.config!=old.config;return false;}
    return true;
  };
  for(const auto& job:autonomous.deferred) {
    if(tombstoned(job)||changedReminder(job.reminderId))continue;
    bool found=false;for(const auto& newJob:incoming.deferred)if(newJob.id==job.id)found=true;
    if(!found)incoming.deferred.push_back(job);
  }
  incoming.deferred.erase(std::remove_if(incoming.deferred.begin(),incoming.deferred.end(),[&](const AutonomousJob& job){return tombstoned(job)||changedReminder(job.reminderId);}),incoming.deferred.end());
  for(auto& job:incoming.history)for(const auto& root:incoming.completedRoots)if(job.rootId==root){job.outcome="completed";job.completedAt=suppliedTime;}

  // Preserve offline actions produced after the client's last read. Their ACK is
  // the durable reconciliation boundary; a stale upload cannot resurrect a root.
  for(const auto& event:events) {
    if(!event.job.length())continue;
    DynamicJsonDocument snapshot(1536);if(deserializeJson(snapshot,event.job))continue;
    AutonomousJob action;if(!parseJob(snapshot.as<JsonObject>(),action))continue;
    if(event.action=="completed") {
      incoming.deferred.erase(std::remove_if(incoming.deferred.begin(),incoming.deferred.end(),[&](const AutonomousJob& job){return job.rootId==action.rootId;}),incoming.deferred.end());
    } else if(event.deferred.length()&&incoming.enabled&&scheduledReminder(incoming,action.reminderId)&&!tombstoned(action)&&!changedReminder(action.reminderId)) {
      snapshot.clear();if(deserializeJson(snapshot,event.deferred))continue;AutonomousJob deferred;if(!parseJob(snapshot.as<JsonObject>(),deferred)||tombstoned(deferred))continue;
      bool found=false;for(const auto& job:incoming.deferred)if(job.id==deferred.id)found=true;
      // Only still-pending device timers are merged; consumed timers stay consumed.
      bool pending=false;for(const auto& job:autonomous.deferred)if(job.id==deferred.id)pending=true;
      if(!found&&pending)incoming.deferred.push_back(deferred);
    }
  }
  incoming.deferred.erase(std::remove_if(incoming.deferred.begin(),incoming.deferred.end(),[&](const AutonomousJob& job){for(const auto& receipt:incoming.history)if(receipt.id==job.id)return true;return false;}),incoming.deferred.end());
  if(incoming.deferred.size()>24){reply(409,"Offline actions exceed deferred capacity; reconcile first");return;}
  const auto oldState=autonomous;const auto oldQueue=queue;
  {
    for(auto it=queue.begin();it!=queue.end();) {
      const auto job=historyJob(it->id);
      if((job&&(tombstoned(*job)||changedReminder(job->reminderId)))||(!job&&[&](){for(const auto& r:autonomous.reminders)if(it->id.startsWith(r.id+":")&&changedReminder(r.id))return true;return false;}()))it=queue.erase(it);else {bool cancelled=false;for(const auto& id:incoming.cancelledIds)if(it->id==id)cancelled=true;if(cancelled)it=queue.erase(it);else ++it;}
    }
    incoming.deferred.erase(std::remove_if(incoming.deferred.begin(),incoming.deferred.end(),[&](const AutonomousJob& job){return !scheduledReminder(incoming,job.reminderId);}),incoming.deferred.end());
  }
  autonomous=incoming;
  if(!saveQueue()){autonomous=oldState;queue=oldQueue;reply(507,"Schedule could not be persisted");return;}
  if(active&&(queue.empty()||oldQueue.empty()||queue.front().id!=oldQueue.front().id)){active=false;setSound(false);lastDraw=0;}
  setenv("TZ",autonomous.timezone.c_str(),1);tzset();trustDesktopTime(suppliedTime);idleState.wake(millis());lastDraw=0;sendSchedule(true);
}
void appendHistory(AutonomousJob job) {
  job.status="delivered";
  for(auto& old:autonomous.history)if(old.id==job.id){old=job;return;}
  // Protect queued notices' metadata so their offline actions always have roots.
  if(autonomous.history.size()>=32){
    auto removable=std::find_if(autonomous.history.begin(),autonomous.history.end(),[](const AutonomousJob& old){for(const auto& n:queue)if(n.id==old.id)return false;return true;});
    if(removable!=autonomous.history.end())autonomous.history.erase(removable);else return;
  }
  autonomous.history.push_back(job);
}
bool recordAutonomousAction(const char* action) {
  AutonomousJob* source=historyJob(queue.front().id);
  DeviceEvent event{randomKey(),queue.front().id,String(action),uint8_t(String(action)=="snoozed"?15:0),"",""};
  if(source) {
    // Completing needs no trusted clock; report device time only if freshly synced.
    AutonomousJob result=*source;result.outcome=action;
    if(String(action)=="completed") {
      if(clockTrusted)result.completedAt=utcMillis();
      autonomous.deferred.erase(std::remove_if(autonomous.deferred.begin(),autonomous.deferred.end(),[&](const AutonomousJob& job){return job.rootId==result.rootId;}),autonomous.deferred.end());
      for(auto& job:autonomous.history)if(job.rootId==result.rootId){job.outcome="completed";job.completedAt=result.completedAt;}
      for(auto it=std::next(queue.begin());it!=queue.end();) {
        const auto member=historyJob(it->id);
        if(member&&member->rootId==result.rootId)it=queue.erase(it);else ++it;
      }
    } else if(autonomous.enabled) {
      if(!clockTrusted || autonomous.deferred.size()>=24)return false;
      AutonomousJob next=result;next.due=utcMillis()+900000;next.expiresAt=next.due+masa::DAY_MS;next.id="snooze-"+event.id;next.outcome="pending";next.status="queued";next.completedAt=0;next.snoozedTo="";
      result.snoozedTo=next.id;autonomous.deferred.push_back(next);event.deferred=jobSnapshot(next);
    }
    appendHistory(result);event.job=jobSnapshot(result);
  }
  events.push_back(event);return true;
}
bool enqueueAutonomous(AutonomousJob job,int64_t now) {
  bool duplicate=false;for(const auto& old:queue)if(old.id==job.id)duplicate=true;for(const auto& old:recent)if(old==job.id)duplicate=true;for(const auto& old:autonomous.history)if(old.id==job.id)duplicate=true;
  if(duplicate){for(const auto& old:queue)if(old.id==job.id){appendHistory(job);break;}return true;}
  if(queue.size()>=QUEUE_LIMIT)return false;
  tm time=masa::local(now);const bool quiet=masa::quietAt(time.tm_hour*60+time.tm_min,autonomous.quietEnabled,autonomous.quietStart,autonomous.quietEnd);
  queue.push_back({job.id,job.title,job.melody=="chime"&&!quiet});appendHistory(job);markDisplayNotice();return true;
}
void tickAutonomous() {
  static uint32_t last=0;
  if(!autonomous.enabled||!clockTrusted||!queueHealthy||millis()-last<1000)return;
  last=millis();const int64_t now=utcMillis();const auto oldState=autonomous;const auto oldQueue=queue;const auto oldDisplay=displayState;bool changed=false;
  for(auto& r:autonomous.reminders) {
    if(!r.enabled||!r.nextDue||r.nextDue>now)continue;
    const int64_t due=masa::latestDue(r.recurrence,r.nextDue,now);
    if(due) {
      AutonomousJob job;job.reminderId=r.id;job.id=r.id+":"+String(double(due),0);job.rootId=job.id;job.title=r.title;job.melody=r.melody;job.due=due;job.expiresAt=due+masa::DAY_MS;
      if(!enqueueAutonomous(job,now))continue; // Advance only when the durable queue can accept it.
    }
    r.nextDue=masa::nextAfter(r.recurrence,now);changed=true;
  }
  for(auto it=autonomous.deferred.begin();it!=autonomous.deferred.end();) {
    if(it->due>now){++it;continue;}
    if(it->expiresAt>now&&!enqueueAutonomous(*it,now)){++it;continue;}
    it=autonomous.deferred.erase(it);changed=true;
  }
  if(changed&&!saveQueue()){autonomous=oldState;queue=oldQueue;displayState=oldDisplay;Serial.println("Autonomous state persistence failed; retrying");}
}
void drawIdle(uint32_t now) {
  if(!queueHealthy){oled.setPowerSave(0);drawLines("Depo hatası Seri monitör kontrol et",0);return;}
  const unsigned contrast=idleDisplayContrast(now);oled.setPowerSave(contrast==0);if(!contrast)return;oled.setContrast(contrast);
  if(!clockTrusted){drawLines("Saat eşitle Bekleniyor  Masa'yı aç",0);return;}
  const int64_t utc=utcMillis();const tm local=masa::local(utc);
  if(!idleState.showDetails(now)) {
    char time[6],date[40];
    snprintf(time,sizeof(time),"%02d:%02d",local.tm_hour,local.tm_min);
    snprintf(date,sizeof(date),"%02d.%02d.%04d",local.tm_mday,local.tm_mon+1,local.tm_year+1900);
    drawIdleClock(time,date);return;
  }
  int64_t next=0;String title;
  if(autonomous.enabled){for(const auto& r:autonomous.reminders)if(r.enabled&&r.nextDue&&(next==0||r.nextDue<next)){next=r.nextDue;title=r.title;}for(const auto& job:autonomous.deferred)if(next==0||job.due<next){next=job.due;title=job.title;}}else next=displayState.nextDue;
  if(!next){drawLines("Sıradaki notYok",0);return;}
  const tm due=masa::local(next);char heading[24];
  snprintf(heading,sizeof(heading),"%02d.%02d %02d:%02d ",due.tm_mday,due.tm_mon+1,due.tm_hour,due.tm_min);
  if(!title.length())title="Masa'dan    hatırlatma";
  const size_t characters=masa::characterCount(title.c_str(),title.length());
  // A fixed two-row preview: long titles never scroll or rotate while idle.
  if(characters>24)title=title.substring(0,masa::characterOffset(title.c_str(),title.length(),21))+"...";
  drawLines(String(heading)+title,0);
}

bool noticeSoundAllowed() {
  if(!autonomous.quietEnabled)return true;
  if(!clockTrusted)return false;
  const tm now=masa::local(utcMillis());
  return !masa::quietAt(now.tm_hour*60+now.tm_min,true,autonomous.quietStart,autonomous.quietEnd);
}
