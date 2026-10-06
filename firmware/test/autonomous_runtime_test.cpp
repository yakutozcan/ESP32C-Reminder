// Native integration harness executes the actual ArduinoJson scheduler headers.
#include <ArduinoJson.h>
#include <atomic>
#include <cassert>
#include <ctime>
#include <deque>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <sys/time.h>
#include "oled_text.h"
class String : public std::string {
public:
  using std::string::string;
  String()=default;
  String(const std::string& text):std::string(text){}
  String(int value):std::string(std::to_string(value)){}
  String(double value,int precision):std::string(){std::ostringstream out;out<<std::fixed<<std::setprecision(precision)<<value;assign(out.str());}
  bool startsWith(const String& prefix)const{return compare(0,prefix.size(),prefix)==0;}
};
namespace ArduinoJson {
template<>struct Converter<String> {
  static void toJson(const String& src,JsonVariant dst){dst.set(static_cast<const std::string&>(src));}
  static String fromJson(JsonVariantConst src){return src.as<std::string>();}
  static bool checkJson(JsonVariantConst src){return src.is<std::string>();}
};
}
uint32_t uptime=1000;int64_t fakeUtc=1791277200000LL;bool persistenceOK=true;
uint32_t millis(){return uptime;}
int simulatedGet(timeval* value,void*){value->tv_sec=fakeUtc/1000;value->tv_usec=(fakeUtc%1000)*1000;return 0;}
int simulatedSet(const timeval* value,const void*){fakeUtc=int64_t(value->tv_sec)*1000+value->tv_usec/1000;return 0;}
#define gettimeofday simulatedGet
#define settimeofday simulatedSet
struct Notice{String id,title;bool chime;};
struct DeviceEvent{String id,notificationId,action;uint8_t minutes;String job,deferred;};
std::deque<Notice> queue;
std::deque<String> recent;
std::deque<DeviceEvent> events;
constexpr size_t QUEUE_LIMIT=8;
bool queueHealthy=true,active=false;
uint32_t lastDraw=0;
struct Server {
  String request,response;int status=0;
  String arg(const char*){return request;}
  void send(int code,const char*,const String& text){status=code;response=text;}
} server;
struct SerialMock{void println(const char*){}} Serial;
struct OLED{void setPowerSave(bool){}void setContrast(unsigned){}} oled;
struct Network{int status(){return 3;}} WiFi;
constexpr int WL_CONNECTED=3;
void drawLines(const String&,size_t){}
void setSound(bool){}
bool authorize(){return true;}
void reply(int code,const char* message){server.status=code;server.response=message;}
String randomKey(){static int n=0;char key[33];snprintf(key,sizeof(key),"%032d",++n);return String(key);}
bool readMelody(JsonObject obj,bool& chime){String value=obj["melody"]|"";chime=value=="chime";return chime||value=="none";}
bool saveQueue();
#include "autonomous_state.h"
#include "autonomous_runtime.h"
int persistenceCount=0;String storedDisplay;
bool saveQueue(){++persistenceCount;if(!persistenceOK)return false;DynamicJsonDocument document(2048);displayStateJson(document.to<JsonObject>(),displayState,true);std::string value;serializeJson(document,value);storedDisplay=value;return true;}
void reset(){displayState=masa::DisplayState{};persistenceCount=0;storedDisplay="";autonomous=AutonomousState{};queue.clear();recent.clear();events.clear();clockTrusted=false;active=false;persistenceOK=true;uptime+=1000;setenv("TZ","UTC0",1);tzset();}
String payload(uint32_t revision=1,const String& owner="desk",bool enabled=true) {
  DynamicJsonDocument doc(8192);
  doc["ownerId"]=owner;doc["revision"]=revision;doc["enabled"]=enabled;doc["timezone"]="UTC0";doc["utcNow"]=fakeUtc;
  JsonObject quiet=doc.createNestedObject("quietHours");quiet["quietEnabled"]=false;quiet["quietStart"]="22:00";quiet["quietEnd"]="08:00";
  JsonObject r=doc.createNestedArray("reminders").createNestedObject();r["id"]="reminder";r["title"]="A test";r["frequency"]="daily";r["time"]="09:00";r["melody"]="chime";r["enabled"]=true;r["nextDue"]=fakeUtc;
  doc.createNestedArray("deferred");doc.createNestedArray("completedRoots");doc.createNestedArray("cancelledIds");
  std::string out;serializeJson(doc,out);return String(out);
}
template<class Edit>String edit(String input,Edit action){DynamicJsonDocument doc(16384);assert(!deserializeJson(doc,input));action(doc);std::string out;serializeJson(doc,out);return String(out);}
void post(const String& body){server.request=body;putSchedule();}
AutonomousJob timer(String id="timer"){AutonomousJob job;job.id=id;job.rootId="root";job.reminderId="reminder";job.title="A test";job.melody="chime";job.due=fakeUtc+900000;job.expiresAt=job.due+masa::DAY_MS;return job;}
int main(){
  reset();post(payload());assert(server.status==200);assert(autonomous.enabled&&clockTrusted);assert(autonomous.revision==1);
  const String first=payload();autonomous.reminders.front().nextDue+=86400000;
  const auto progressed=autonomous.reminders.front().nextDue;autonomous.deferred.push_back(timer());
  post(first);assert(server.status==200);assert(autonomous.reminders.front().nextDue==progressed);assert(autonomous.deferred.size()==1);
  post(edit(first,[](DynamicJsonDocument& d){d["reminders"][0]["title"]="Changed";}));assert(server.status==409);assert(autonomous.reminders.front().title=="A test");
  post(payload(0));assert(server.status==409);
  post(payload(2,"other"));assert(server.status==409);assert(autonomous.ownerId=="desk");
  post(payload(2));assert(server.status==200);assert(autonomous.reminders.front().nextDue==progressed);assert(autonomous.deferred.size()==1);
  persistenceOK=false;post(edit(payload(3),[](DynamicJsonDocument& d){d["reminders"][0]["title"]="Changed";}));assert(server.status==507);assert(autonomous.revision==2);assert(autonomous.deferred.size()==1);persistenceOK=true;
  post(edit(payload(3),[](DynamicJsonDocument& d){d["completedRoots"].add("root");}));assert(server.status==200);assert(autonomous.deferred.empty());
  reset();post(payload());autonomous.deferred.push_back(timer());
  post(edit(payload(2),[](DynamicJsonDocument& d){d["reminders"][0]["enabled"]=false;}));assert(server.status==200);assert(autonomous.deferred.empty());
  reset();post(payload());AutonomousJob original=timer("notice");original.due=fakeUtc;original.expiresAt=fakeUtc+masa::DAY_MS;
  assert(enqueueAutonomous(original,fakeUtc));assert(queue.size()==1);assert(autonomous.history.front().status=="delivered");
  assert(recordAutonomousAction("snoozed"));assert(autonomous.deferred.size()==1);assert(autonomous.deferred.front().id.startsWith("snooze-"));assert(autonomous.deferred.front().status=="queued");assert(autonomous.history.front().outcome=="snoozed");
  DynamicJsonDocument event(1536);assert(!deserializeJson(event,events.front().deferred));assert(event["status"]=="queued");
  post(payload(2));assert(server.status==200);assert(autonomous.deferred.size()==1); // Stale upload cannot lose local snooze.
  post(edit(payload(3),[](DynamicJsonDocument& d){d["completedRoots"].add("root");}));assert(server.status==200);assert(autonomous.deferred.empty());assert(queue.empty());assert(autonomous.history.front().outcome=="completed");
  reset();post(payload());autonomous.quietEnabled=true;autonomous.quietStart=0;autonomous.quietEnd=1439;
  assert(enqueueAutonomous(original,fakeUtc));assert(!queue.front().chime);assert(autonomous.history.front().melody=="chime");
  assert(recordAutonomousAction("snoozed"));assert(autonomous.deferred.front().melody=="chime");
  reset();post(payload());autonomous.reminders.front().nextDue=fakeUtc;const auto before=autonomous.reminders.front().nextDue;persistenceOK=false;tickAutonomous();assert(queue.empty());assert(autonomous.history.empty());assert(autonomous.reminders.front().nextDue==before);persistenceOK=true;uptime+=1000;tickAutonomous();assert(queue.size()==1);assert(autonomous.history.size()==1);assert(autonomous.reminders.front().nextDue>fakeUtc);
  const auto count=queue.size();uptime+=1000;tickAutonomous();assert(queue.size()==count);
  reset();post(payload());clockTrusted=false;tickAutonomous();assert(queue.empty());
  // Validation rejects oversized imports atomically and disabled equal quiet bounds are accepted.
  reset();post(edit(payload(),[](DynamicJsonDocument& d){for(int i=0;i<24;++i)d["reminders"].add(d["reminders"][0]);}));assert(server.status==400);assert(!autonomous.enabled);
  post(edit(payload(),[](DynamicJsonDocument& d){d["quietHours"]["quietEnd"]="22:00";}));assert(server.status==200);
  reset();post(edit(payload(),[](DynamicJsonDocument& d){d["quietHours"]["quietEnd"]="22:00";d["quietHours"]["quietEnabled"]=true;}));assert(server.status==400);
  reset();post(payload());assert(enqueueAutonomous(original,fakeUtc));assert(recordAutonomousAction("snoozed"));
  DynamicJsonDocument stored(16384);stateJson(stored.to<JsonObject>(),autonomous,true);AutonomousState restored;
  assert(parseState(stored.as<JsonObject>(),restored,true));assert(restored.fingerprint==autonomous.fingerprint);assert(restored.history.front().status=="delivered");assert(restored.deferred.front().status=="queued");
  clockTrusted=false;autonomous=restored;uptime+=1000;const size_t afterReboot=queue.size();tickAutonomous();assert(queue.size()==afterReboot);assert(!clockTrusted);
  post(payload(2,"other"));assert(server.status==409);
  post(edit(payload(2,"other"),[](DynamicJsonDocument& d){d["takeover"]=true;}));assert(server.status==200);assert(autonomous.ownerId=="other");
  post(payload(3,"other",false));assert(server.status==200);assert(!autonomous.enabled);
  reset();post(payload());autonomous.deferred.push_back(timer());autonomous.reminders.front().nextDue=fakeUtc+86400000;
  post(edit(payload(2),[](DynamicJsonDocument& d){d["timezone"]="STD-3";d["reminders"][0]["nextDue"]=fakeUtc+7200000;}));
  assert(server.status==200);assert(autonomous.reminders.front().nextDue==fakeUtc+7200000);assert(autonomous.deferred.front().due==fakeUtc+900000);
  assert(validTitle("Çç Ğğ İı Öö Şş Üü"));assert(!validTitle(String(81,'a')));assert(!validTitle("newline\n"));assert(!validTitle("   "));
  auto cronPayload=[&](uint32_t revision,const char* expression){return edit(payload(revision),[&](DynamicJsonDocument& d){d["reminders"][0]["frequency"]="cron";d["reminders"][0]["time"]="00:00";d["reminders"][0]["cronExpression"]=expression;});};
  reset();post(cronPayload(1,"*/15 9 * * 1-5"));assert(server.status==200);assert(autonomous.reminders.front().recurrence.kind==masa::Recurrence::Cron);
  uptime+=1000;tickAutonomous();assert(queue.size()==1);assert(autonomous.reminders.front().nextDue==fakeUtc+900000);
  const auto cronProgress=autonomous.reminders.front().nextDue;post(cronPayload(1,"*/15 9 * * 1-5"));assert(server.status==200);assert(autonomous.reminders.front().nextDue==cronProgress);
  post(cronPayload(1,"*/30 9 * * 1-5"));assert(server.status==409);assert(autonomous.reminders.front().nextDue==cronProgress);
  post(edit(cronPayload(2,"*/30 9 * * 1-5"),[](DynamicJsonDocument& d){d["reminders"][0]["nextDue"]=fakeUtc+1800000;}));assert(server.status==200);assert(queue.empty());assert(autonomous.reminders.front().nextDue==fakeUtc+1800000);
  DynamicJsonDocument cronStored(16384);stateJson(cronStored.to<JsonObject>(),autonomous,true);AutonomousState cronRestored;assert(parseState(cronStored.as<JsonObject>(),cronRestored,true));assert(cronRestored.reminders.front().recurrence.kind==masa::Recurrence::Cron);assert(masa::nextAfter(cronRestored.reminders.front().recurrence,fakeUtc)==fakeUtc+1800000);
  post(cronPayload(3,"0 9 31 2 *"));assert(server.status==400);assert(autonomous.revision==2);assert(autonomous.reminders.front().nextDue==fakeUtc+1800000);
  post(cronPayload(3,"0 9 * * MON"));assert(server.status==400);assert(autonomous.revision==2); // Desktop must expand names.
  post(cronPayload(3,"*/0 * * * *"));assert(server.status==400);
  reset();post(edit(cronPayload(1,"0 9 * * *"),[](DynamicJsonDocument& d){d["reminders"][0].remove("time");}));assert(server.status==200); // Cron ignores the time placeholder.
  auto displayPayload=[&](int64_t due=0){DynamicJsonDocument d(2048);JsonObject settings=d.createNestedObject("settings");settings["alwaysOn"]=false;settings["sleepMinutes"]=2;settings["wakeBeforeMinutes"]=10;settings["wakeAfterMinutes"]=10;if(due)d["nextDue"]=due;else d["nextDue"]=nullptr;d["utcNow"]=fakeUtc;std::string out;serializeJson(d,out);return String(out);};
  auto postDisplay=[&](const String& value){server.request=value;putDisplay();};
  reset();getDisplay();assert(server.status==200);assert(persistenceCount==0);assert(!clockTrusted);
  postDisplay(displayPayload());assert(server.status==200);assert(clockTrusted);assert(persistenceCount==0); // Refresh time without writing identical defaults.
  post(payload());const auto owner=autonomous.ownerId;const auto revision=autonomous.revision;const int displaySaveCount=persistenceCount;
  postDisplay(displayPayload(fakeUtc+900000));assert(server.status==200);assert(displayState.nextDue==fakeUtc+900000);assert(persistenceCount==displaySaveCount+1);assert(autonomous.ownerId==owner&&autonomous.revision==revision&&autonomous.enabled);
  postDisplay(displayPayload(fakeUtc+900000));assert(server.status==200);assert(persistenceCount==displaySaveCount+1);getDisplay();assert(persistenceCount==displaySaveCount+1);
  persistenceOK=false;postDisplay(edit(displayPayload(fakeUtc+1800000),[](DynamicJsonDocument& d){d["settings"]["alwaysOn"]=true;}));assert(server.status==507);assert(!displayState.settings.alwaysOn);assert(displayState.nextDue==fakeUtc+900000);assert(autonomous.revision==revision);persistenceOK=true;
  for(const char* key:{"sleepMinutes","wakeBeforeMinutes","wakeAfterMinutes"}) {postDisplay(edit(displayPayload(),[&](DynamicJsonDocument& d){d["settings"][key]=1441;}));assert(server.status==400);}
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d["settings"]["sleepMinutes"]=0;}));assert(server.status==400);
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d["settings"]["wakeBeforeMinutes"]=-1;}));assert(server.status==400);
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d["settings"]["alwaysOn"]="false";}));assert(server.status==400);
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d["settings"]["sleepMinutes"]=1.5;}));assert(server.status==400);
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d.remove("nextDue");}));assert(server.status==400);
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d["utcNow"]="invalid";}));assert(server.status==400);
  postDisplay(String(2049,' '));assert(server.status==413);
  postDisplay(edit(displayPayload(),[](DynamicJsonDocument& d){d["settings"]["sleepMinutes"]=1440;d["settings"]["wakeBeforeMinutes"]=0;d["settings"]["wakeAfterMinutes"]=0;d["settings"]["alwaysOn"]=true;}));assert(server.status==200);clockTrusted=false;assert(idleDisplayContrast(UINT32_MAX)==180);assert(autonomous.ownerId==owner&&autonomous.revision==revision);
  DynamicJsonDocument displayStored(2048);assert(!deserializeJson(displayStored,storedDisplay));masa::DisplayState rebooted;assert(parseStoredDisplay(displayStored.as<JsonVariant>(),rebooted));assert(rebooted==displayState);
  DynamicJsonDocument legacy(128);masa::DisplayState defaults;assert(parseStoredDisplay(legacy["display"],defaults));assert(defaults==masa::DisplayState{});
  displayStored["settings"]["sleepMinutes"]=0;assert(!parseStoredDisplay(displayStored.as<JsonVariant>(),rebooted));
  reset();autonomous.enabled=false;idleState.awakeSince=0;uptime=1000000;postDisplay(displayPayload(fakeUtc+600000));assert(idleDisplayContrast(uptime)==180);
  fakeUtc+=600001;postDisplay(displayPayload(fakeUtc+86400000));assert(displayState.previousDue==fakeUtc-1);assert(idleDisplayContrast(uptime)==180);fakeUtc+=600000;assert(idleDisplayContrast(uptime)==0);
  reset();autonomous.enabled=false;idleState.awakeSince=0;uptime=1000000;postDisplay(displayPayload(fakeUtc+600000));postDisplay(displayPayload());assert(!displayState.previousDue);assert(idleDisplayContrast(uptime)==0);
  reset();post(payload());idleState.awakeSince=0;uptime=1000000;autonomous.reminders.front().nextDue=fakeUtc+600000;displayState.nextDue=fakeUtc+86400000;assert(idleDisplayContrast(uptime)==180);autonomous.reminders.front().enabled=false;assert(idleDisplayContrast(uptime)==0);autonomous.deferred.push_back(timer());autonomous.deferred.front().due=fakeUtc+600000;assert(idleDisplayContrast(uptime)==180);clockTrusted=false;assert(idleDisplayContrast(uptime)==0);
  clockTrusted=true;autonomous.deferred.clear();markDisplayNotice();assert(idleDisplayContrast(uptime)==180);fakeUtc+=600000;assert(idleDisplayContrast(uptime)==0);
  std::cout<<"Actual firmware API, ownership, revisions, timer races, quiet melody and rollback tests passed\n";
}
