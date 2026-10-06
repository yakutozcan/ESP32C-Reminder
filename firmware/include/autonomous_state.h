#pragma once
#include "autonomous_clock.h"
#include <vector>
#include <atomic>
struct AutonomousReminder {
  String id,title,melody,config;
  masa::Recurrence recurrence;
  bool enabled=true;
  int64_t nextDue=0;
};
struct AutonomousJob {
  String id,rootId,reminderId,title,melody,outcome="pending",status="queued";
  int64_t due=0,expiresAt=0,completedAt=0;
  String snoozedTo;
};
struct AutonomousState {
  String ownerId,timezone="UTC0",fingerprint;
  uint32_t revision=0;
  bool enabled=false,quietEnabled=false;
  int quietStart=1320,quietEnd=480;
  std::vector<AutonomousReminder> reminders;
  std::vector<AutonomousJob> deferred,history;
  std::vector<String> completedRoots,cancelledIds;
};
AutonomousState autonomous;
std::atomic<bool> clockTrusted{false};
bool filesystemReady=false;
masa::IdleState idleState;
int64_t utcMillis() { timeval now{};gettimeofday(&now,nullptr);return int64_t(now.tv_sec)*1000+now.tv_usec/1000; }
bool validMillis(JsonVariant value, bool nullable=false) {
  if (nullable && value.isNull()) return true;
  if(!value.is<int64_t>() && !value.is<double>()) return false;
  double n=value.as<double>();return n>=946684800000.0 && n<=(sizeof(time_t)>=8?4102444800000.0:2145916800000.0) && n==double(int64_t(n));
}
int readMinute(JsonVariant value) {
  if(!value.is<String>()) return -1;
  String s=value.as<String>();
  if(s.length()!=5 || s[2]!=':' || s[0]<'0'||s[0]>'2'||s[1]<'0'||s[1]>'9'||s[3]<'0'||s[3]>'5'||s[4]<'0'||s[4]>'9')return -1;
  int m=(s[0]-'0')*600+(s[1]-'0')*60+(s[3]-'0')*10+s[4]-'0';return m<1440?m:-1;
}
String minuteText(int minute) {char text[6];snprintf(text,sizeof(text),"%02d:%02d",minute/60,minute%60);return String(text);}
bool validTitle(const String& text) {
  if(!text.length()||text.length()>320)return false;
  size_t count=0;bool visible=false;
  for(size_t offset=0;offset<text.length();) {
    auto character=masa::nextCharacter(text.c_str()+offset,text.length()-offset);
    if(character.codepoint<32||character.codepoint==127||(character.codepoint==0xFFFD&&character.bytes==1)||++count>80)return false;
    if(character.codepoint!=32&&character.codepoint!=0xA0&&character.codepoint!=0x1680&&!(character.codepoint>=0x2000&&character.codepoint<=0x200A)&&character.codepoint!=0x2028&&character.codepoint!=0x2029&&character.codepoint!=0x202F&&character.codepoint!=0x205F&&character.codepoint!=0x3000&&character.codepoint!=0xFEFF)visible=true;
    offset+=character.bytes;
  }
  return visible;
}
bool validId(JsonVariant value) {return value.is<String>() && value.as<String>().length()>0 && value.as<String>().length()<=160;}
void jobJson(JsonObject obj,const AutonomousJob& job) {
  obj["id"]=job.id;obj["rootId"]=job.rootId;obj["reminderId"]=job.reminderId;obj["title"]=job.title;obj["melody"]=job.melody;
  obj["due"]=job.due;obj["expiresAt"]=job.expiresAt;obj["status"]=job.status;obj["outcome"]=job.outcome;
  if(job.completedAt)obj["completedAt"]=job.completedAt;
  if(job.snoozedTo.length())obj["snoozedTo"]=job.snoozedTo;
}
String jobSnapshot(const AutonomousJob& job) {DynamicJsonDocument doc(1536);jobJson(doc.to<JsonObject>(),job);String s;serializeJson(doc,s);return s;}
bool parseJob(JsonObject obj,AutonomousJob& job) {
  bool chime;
  if(!validId(obj["id"])||!validId(obj["rootId"])||!validId(obj["reminderId"])||!obj["title"].is<String>()||!readMelody(obj,chime)||!validMillis(obj["due"])||!validMillis(obj["expiresAt"]))return false;
  job.id=obj["id"].as<String>();job.rootId=obj["rootId"].as<String>();job.reminderId=obj["reminderId"].as<String>();job.title=obj["title"].as<String>();job.melody=chime?"chime":"none";
  if(!validTitle(job.title)||job.reminderId.length()>128)return false;
  job.due=obj["due"].as<int64_t>();job.expiresAt=obj["expiresAt"].as<int64_t>();if(job.expiresAt<=job.due||job.expiresAt-job.due>masa::DAY_MS)return false;
  job.status=obj["status"]|"queued";if(job.status!="queued"&&job.status!="delivered")return false;
  job.outcome=obj["outcome"]|"pending";
  if(job.outcome!="pending"&&job.outcome!="completed"&&job.outcome!="snoozed")return false;
  if(obj.containsKey("completedAt")&&!validMillis(obj["completedAt"]))return false;
  if(obj.containsKey("snoozedTo")&&!validId(obj["snoozedTo"]))return false;
  job.completedAt=obj["completedAt"]|int64_t(0);job.snoozedTo=obj["snoozedTo"]|"";
  return true;
}
bool parseReminder(JsonObject obj,AutonomousReminder& r) {
  bool chime;
  if(!validId(obj["id"])||!obj["title"].is<String>()||!readMelody(obj,chime)||!obj["enabled"].is<bool>()||!validMillis(obj["nextDue"],true))return false;
  r.id=obj["id"].as<String>();if(r.id.length()>128)return false;r.title=obj["title"].as<String>();r.melody=chime?"chime":"none";r.enabled=obj["enabled"].as<bool>();r.nextDue=obj["nextDue"]|int64_t(0);
  if(!validTitle(r.title))return false;
  auto& rule=r.recurrence;
  String frequency=obj["frequency"]|"";
  rule.minute=readMinute(obj["time"]);if(rule.minute<0)return false;
  if(frequency=="once") {rule.kind=masa::Recurrence::Once;if(!validMillis(obj["scheduledAt"]))return false;rule.scheduledAt=obj["scheduledAt"].as<int64_t>();}
  else if(frequency=="daily")rule.kind=masa::Recurrence::Daily;
  else if(frequency=="monthly") {rule.kind=masa::Recurrence::Monthly;rule.monthDay=obj["monthDay"]|0;if(rule.monthDay<1||rule.monthDay>31)return false;}
  else if(frequency=="weekly"||frequency=="interval") {
    rule.kind=frequency=="weekly"?masa::Recurrence::Weekly:masa::Recurrence::Interval;
    if(!obj["weekdays"].is<JsonArray>()||!obj["weekdays"].size()||obj["weekdays"].size()>7)return false;
    rule.weekdays=0;for(JsonVariant day:obj["weekdays"].as<JsonArray>()){if(!day.is<int>()||day.as<int>()<0||day.as<int>()>6)return false;rule.weekdays|=1u<<day.as<int>();}
    if(frequency=="weekly") {
      rule.weekInterval=obj["weekInterval"]|1;if(rule.weekInterval<1||rule.weekInterval>2)return false;
      String anchor=obj["anchorDate"]|"";if(anchor.length()!=10||sscanf(anchor.c_str(),"%d-%d-%d",&rule.anchorYear,&rule.anchorMonth,&rule.anchorDay)!=3||rule.anchorYear<2000||rule.anchorYear>2099||rule.anchorMonth<1||rule.anchorMonth>12||rule.anchorDay<1||rule.anchorDay>31)return false;
    } else {
      if(!obj["intervalMinutes"].is<int>()||!validMillis(obj["anchorAt"]))return false;
      rule.intervalMinutes=obj["intervalMinutes"].as<int>();rule.anchorAt=obj["anchorAt"].as<int64_t>();if(rule.intervalMinutes<1||rule.intervalMinutes>10080)return false;
      String start=obj["workStart"]|"",end=obj["workEnd"]|"";
      if(start.length()||end.length()){rule.workStart=readMinute(obj["workStart"]);rule.workEnd=readMinute(obj["workEnd"]);if(rule.workStart<0||rule.workEnd<=rule.workStart)return false;}
    }
  } else return false;
  // Serialize without the moving cursor; configuration equality preserves progress.
  DynamicJsonDocument config(2048);config.set(obj);config.remove("nextDue");serializeJson(config,r.config);
  return !config.overflowed();
}
void stateJson(JsonObject obj,const AutonomousState& state,bool storage) {
  obj["ownerId"]=state.ownerId;obj["revision"]=state.revision;obj["enabled"]=state.enabled;obj["timezone"]=state.timezone;
  JsonObject quiet=obj.createNestedObject("quietHours");quiet["quietEnabled"]=state.quietEnabled;quiet["quietStart"]=minuteText(state.quietStart);quiet["quietEnd"]=minuteText(state.quietEnd);
  if(storage) {
    obj["fingerprint"]=state.fingerprint;
    JsonArray rs=obj.createNestedArray("reminders");
    for(const auto& r:state.reminders){DynamicJsonDocument config(2048);deserializeJson(config,r.config);JsonObject record=rs.createNestedObject();record.set(config.as<JsonObject>());if(r.nextDue)record["nextDue"]=r.nextDue;else record["nextDue"]=nullptr;}
  } else {
    obj["protocol"]=4;obj["timeValid"]=clockTrusted.load();
    JsonArray cursors=obj.createNestedArray("cursors");for(const auto& r:state.reminders){JsonObject record=cursors.createNestedObject();record["id"]=r.id;if(r.nextDue)record["nextDue"]=r.nextDue;else record["nextDue"]=nullptr;}
  }
  if(storage) {JsonArray completed=obj.createNestedArray("completedRoots");for(const auto& id:state.completedRoots)completed.add(id);JsonArray cancelled=obj.createNestedArray("cancelledIds");for(const auto& id:state.cancelledIds)cancelled.add(id);}
  JsonArray deferred=obj.createNestedArray("deferred");for(const auto& job:state.deferred)jobJson(deferred.createNestedObject(),job);
  JsonArray history=obj.createNestedArray("history");for(const auto& job:state.history)jobJson(history.createNestedObject(),job);
}
bool parseState(JsonObject obj,AutonomousState& state,bool storage=false) {
  if(!obj["ownerId"].is<String>()||obj["ownerId"].as<String>().length()>128||(!storage&&!obj["ownerId"].as<String>().length())||!obj["revision"].is<uint32_t>()||!obj["enabled"].is<bool>()||!obj["timezone"].is<String>()||!obj["reminders"].is<JsonArray>()||obj["reminders"].size()>24||!obj["deferred"].is<JsonArray>()||obj["deferred"].size()>24)return false;
  state.ownerId=obj["ownerId"].as<String>();state.revision=obj["revision"].as<uint32_t>();state.enabled=obj["enabled"].as<bool>();state.timezone=obj["timezone"].as<String>();
  if(state.timezone.length()<3||state.timezone.length()>128)return false;
  // POSIX TZ only: prevent control bytes and filesystem timezone strings.
  for(size_t i=0;i<state.timezone.length();++i){char c=state.timezone[i];if(!isalnum(c)&&c!='+'&&c!='-'&&c!=','&&c!='.'&&c!='/'&&c!=':')return false;}
  JsonObject quiet=obj["quietHours"].as<JsonObject>();if(!quiet["quietEnabled"].is<bool>())return false;
  state.quietEnabled=quiet["quietEnabled"].as<bool>();state.quietStart=readMinute(quiet["quietStart"]);state.quietEnd=readMinute(quiet["quietEnd"]);
  if(state.quietStart<0||state.quietEnd<0||(state.quietEnabled&&state.quietStart==state.quietEnd))return false;
  for(JsonObject item:obj["reminders"].as<JsonArray>()){AutonomousReminder r;if(!parseReminder(item,r))return false;for(const auto& old:state.reminders)if(old.id==r.id)return false;state.reminders.push_back(r);}
  for(JsonObject item:obj["deferred"].as<JsonArray>()){AutonomousJob job;if(!parseJob(item,job)||job.status!="queued"||job.outcome!="pending")return false;for(const auto& old:state.deferred)if(old.id==job.id)return false;state.deferred.push_back(job);}
  for(const char* key:{"completedRoots","cancelledIds"})if(obj.containsKey(key)){if(!obj[key].is<JsonArray>()||obj[key].size()>100)return false;for(JsonVariant id:obj[key].as<JsonArray>()){if(!validId(id))return false;if(String(key)=="completedRoots")state.completedRoots.push_back(id.as<String>());else state.cancelledIds.push_back(id.as<String>());}}
  if(storage){if(!obj["history"].is<JsonArray>()||obj["history"].size()>32)return false;for(JsonObject item:obj["history"].as<JsonArray>()){AutonomousJob job;if(!parseJob(item,job)||job.status!="delivered")return false;for(const auto& old:state.history)if(old.id==job.id)return false;for(const auto& old:state.deferred)if(old.id==job.id)return false;state.history.push_back(job);}state.fingerprint=obj["fingerprint"]|"";}
  return true;
}
