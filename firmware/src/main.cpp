#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <U8g2lib.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <esp_system.h>
#include <AyresWiFiManager.h>
#include <LittleFS.h>
#include <HTTPClient.h>
#include <time.h>
#include <sys/time.h>
#include <esp_sntp.h>
#include <esp_partition.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <deque>
#include "setup_page.h"
#include "oled_text.h"
#include "button_gesture.h"
#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif
#ifndef BUZZER_PIN
#ifdef MOTOR_PIN
#define BUZZER_PIN MOTOR_PIN
#else
#define BUZZER_PIN 3
#endif
#endif

static_assert(BUZZER_PIN != OLED_SDA && BUZZER_PIN != OLED_SCL && BUZZER_PIN != ACK_BUTTON_PIN,
              "Buzzer GPIO conflicts with OLED or button");
static_assert(BUZZER_PIN != 18 && BUZZER_PIN != 19 && BUZZER_PIN != 8 && BUZZER_PIN != 2,
              "Choose a free GPIO: avoid USB, LED and strapping pins");
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
WebServer server(80);
// GPIO8 is the board LED. BOOT remains under Masa's control (no erase-on-hold).
AyresWiFiManager wifiManager(8, ACK_BUTTON_PIN);
bool apiStarted = false;
Preferences preferences;
struct Notice { String id; String title; bool chime; };
struct DeviceEvent { String id; String notificationId; String action; uint8_t minutes; String job; String deferred; };
std::deque<Notice> queue;
std::deque<String> recent;
std::deque<DeviceEvent> events;
constexpr size_t EVENT_LIMIT = 16;
constexpr size_t QUEUE_LIMIT = 8;
constexpr size_t RECENT_LIMIT = 32;
bool active = false;
bool mdnsStarted = false;
bool hasConnected = false;
bool storageReady = false;
bool queueHealthy = true;
bool oledPresent = false;
uint32_t activeSince = 0, lastDraw = 0, lastConnected = 0;
masa::ButtonGesture buttonGesture;
String buttonNoticeId;
String actionFeedback;
uint32_t feedbackSince = 0;
constexpr uint8_t BUZZER_CHANNEL = 0;
QueueHandle_t soundCommands = nullptr;
bool setupMode = false;
String deviceToken, setupSsid;

// Exercise Ayres' actual HTTP scan handler through the loop, without a second scanner.
void scanPortalTask(void*) {
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(15000);
  http.begin(client, "http://192.168.4.1/scan");
  const int code = http.GET();
  if (code == 200) {
    DynamicJsonDocument doc(8192);
    const auto error = deserializeJson(doc, http.getString());
    if (!error && doc.is<JsonArray>()) Serial.println("Ayres scan networks: " + String(doc.size()));
    else Serial.println("Ayres scan response invalid");
  } else Serial.println("Ayres scan HTTP: " + String(code));
  http.end();
  http.begin(client, "http://192.168.4.1/");
  const int pageCode = http.GET();
  const String page = http.getString();
  const bool ready = pageCode == 200 && page.indexOf("action=\"/save\"") >= 0 &&
                     page.indexOf("fetch('/scan'") >= 0 && deviceToken.length() >= 24 &&
                     page.indexOf(deviceToken) >= 0;
  Serial.println("Ayres Turkish portal page: " + String(ready ? "ready" : "unavailable"));
  http.end();
  vTaskDelete(nullptr);
}

void soundTask(void*) {
  const uint16_t notes[] = {1047, 1319, 1568, 2093}; // C6, E6, G6, C7.
  const uint16_t durations[] = {140, 140, 140, 260};
  uint8_t command = 0;
  for (;;) {
    if (!command) xQueueReceive(soundCommands, &command, portMAX_DELAY);
    if (!command) continue;
    bool interrupted = false;
    for (size_t i = 0; i < 4; i++) {
      ledcWriteTone(BUZZER_CHANNEL, notes[i]);
      if (xQueueReceive(soundCommands, &command, pdMS_TO_TICKS(durations[i])) == pdTRUE) { interrupted = true; break; }
      ledcWriteTone(BUZZER_CHANNEL, 0);
      if (xQueueReceive(soundCommands, &command, pdMS_TO_TICKS(50)) == pdTRUE) { interrupted = true; break; }
    }
    ledcWriteTone(BUZZER_CHANNEL, 0);
    if (!interrupted) Serial.println("Chime finished (PWM off)");
    if (!interrupted) command = 0;
  }
}
void setSound(bool chime) {
  if (!soundCommands) return;
  const uint8_t command = chime ? 1 : 0;
  xQueueOverwrite(soundCommands, &command);
}
bool readMelody(JsonObject obj, bool& chime, bool allowLegacy = false) {
  if (obj["melody"].is<String>()) {
    const String melody = obj["melody"].as<String>();
    if (melody != "chime" && melody != "none") return false;
    chime = melody == "chime";
    return true;
  }
  if (allowLegacy && obj["vibrationMs"].is<uint32_t>() && obj["vibrationMs"].as<uint32_t>() <= 5000) {
    chime = obj["vibrationMs"].as<uint32_t>() != 0;
    return true;
  }
  return false;
}

#include "autonomous_state.h"
#include "atomic_snapshot.h"

bool saveQueue() {
  if (!storageReady) return false;
  DynamicJsonDocument doc(98304);
  JsonArray pending = doc["pending"].to<JsonArray>();
  for (const auto& notice : queue) {
    JsonObject obj = pending.createNestedObject();
    obj["id"] = notice.id; obj["title"] = notice.title; obj["melody"] = notice.chime ? "chime" : "none";
  }
  JsonArray seen = doc["recent"].to<JsonArray>();
  for (const auto& id : recent) seen.add(id);
  JsonArray actions = doc["events"].to<JsonArray>();
  for (const auto& event : events) {
    JsonObject obj = actions.createNestedObject();
    obj["id"] = event.id; obj["notificationId"] = event.notificationId; obj["action"] = event.action;
    if (event.action == "snoozed") obj["minutes"] = event.minutes;
    if (event.job.length()) { DynamicJsonDocument snapshot(1536); deserializeJson(snapshot,event.job); obj["job"].set(snapshot); }
    if (event.deferred.length()) { DynamicJsonDocument snapshot(1536); deserializeJson(snapshot,event.deferred); obj["deferred"].set(snapshot); }
  }
  doc["format"] = 4;
  stateJson(doc.createNestedObject("schedule"),autonomous,true);
  if (doc.overflowed()) return false;
  String data;
  serializeJson(doc, data);
  if (!filesystemReady) return false;
  // NVS original remains intact for rollback; Wi-Fi lives in another file.
  return masa::writeSnapshot(LittleFS,"/masa-state.json","/masa-state.tmp",reinterpret_cast<const uint8_t*>(data.c_str()),data.length());
}
bool loadQueue() {
  String data;
  const bool migrated=filesystemReady && LittleFS.exists("/masa-state.json");
  if(migrated) {File file=LittleFS.open("/masa-state.json","r");if(!file || file.size()>98304)return false;data=file.readString();file.close();}
  else data=preferences.getString("queue", "");
  if (!data.length()) return !migrated;
  DynamicJsonDocument doc(98304);
  if (deserializeJson(doc, data)) return false;
  if (!doc["pending"].is<JsonArray>() || !doc["recent"].is<JsonArray>()) return false;
  for (JsonObject obj : doc["pending"].as<JsonArray>()) {
    bool chime;
    if (!obj["id"].is<String>() || !obj["title"].is<String>() || !readMelody(obj, chime, true) ||
        queue.size() >= QUEUE_LIMIT) return false;
    queue.push_back({obj["id"].as<String>(), obj["title"].as<String>(), chime});
  }
  for (JsonVariant id : doc["recent"].as<JsonArray>()) {
    if (!id.is<String>() || recent.size() >= RECENT_LIMIT) return false;
    recent.push_back(id.as<String>());
  }
  // Existing protocol-2 queues do not have events. Keep pending and recent IDs intact.
  if (doc.containsKey("events")) {
    if (!doc["events"].is<JsonArray>()) return false;
    for (JsonObject obj : doc["events"].as<JsonArray>()) {
      const String action = obj["action"].as<String>();
      if (!obj["id"].is<String>() || obj["id"].as<String>().length() != 32 ||
          !obj["notificationId"].is<String>() || !obj["notificationId"].as<String>().length() ||
          obj["notificationId"].as<String>().length() > 160 ||
          (action != "completed" && action != "snoozed") ||
          (action == "snoozed" && obj["minutes"].as<int>() != 15) || events.size() >= EVENT_LIMIT) return false;
      String job,deferred;
      if(obj["job"].is<JsonObject>()){AutonomousJob snapshot;if(!parseJob(obj["job"],snapshot))return false;job=jobSnapshot(snapshot);}
      if(obj["deferred"].is<JsonObject>()){AutonomousJob snapshot;if(!parseJob(obj["deferred"],snapshot))return false;deferred=jobSnapshot(snapshot);}
      events.push_back({obj["id"].as<String>(), obj["notificationId"].as<String>(), action, uint8_t(action == "snoozed" ? 15 : 0),job,deferred});
    }
  }
  if(migrated) {
    if(doc["format"].as<int>()!=4 || !parseState(doc["schedule"],autonomous,true))return false;
    setenv("TZ",autonomous.timezone.c_str(),1);tzset();
  }
  return true;
}
void reply(int code, const char* message) {
  DynamicJsonDocument doc(256);
  doc["protocol"] = 4; doc["error"] = message;
  String body; serializeJson(doc, body);
  server.send(code, "application/json", body);
}
bool authorize() {
  if (setupMode || deviceToken.length() < 24) { reply(503, "Finish Wi-Fi setup first"); return false; }
  if (server.header("Authorization") != String("Bearer ") + deviceToken) {
    reply(401, "Unauthorized"); return false;
  }
  return true;
}
void health() {
  if (!authorize()) return;
  if (!queueHealthy) { reply(503, "Persistent queue is corrupt; inspect serial monitor"); return; }
  DynamicJsonDocument doc(1024);
  doc["protocol"] = 4; doc["name"] = "Masa ESP32-C3"; doc["firmware"] = "0.7.0";
  doc["autonomous"]=autonomous.enabled;doc["timeValid"]=clockTrusted.load();doc["ownerId"]=autonomous.ownerId;doc["revision"]=autonomous.revision;
  doc["cron"]=true;
  doc["scheduleMaxTimestamp"]=int64_t(sizeof(time_t)>=8?4102444800000LL:2145916800000LL);
  doc["eventsPending"] = events.size();
  doc["sound"] = soundCommands ? "passive-buzzer" : "unavailable";
  doc["oledI2c"] = oledPresent;
  doc["pending"] = queue.size(); doc["ip"] = WiFi.localIP().toString(); doc["rssi"] = WiFi.RSSI();
  String body; serializeJson(doc, body); server.send(200, "application/json", body);
}
void notify() {
  if (!authorize()) return;
  if (!queueHealthy) { reply(503, "Persistent queue is corrupt"); return; }
  const String body = server.arg("plain");
  if (body.length() > 1024) { reply(413, "Payload too large"); return; }
  DynamicJsonDocument doc(2048);
  bool chime;
  if (deserializeJson(doc, body) || !doc["id"].is<String>() || !doc["title"].is<String>() || !readMelody(doc.as<JsonObject>(), chime)) {
    reply(400, "Invalid notification"); return;
  }
  String id = doc["id"].as<String>();
  String title = doc["title"].as<String>(); title.trim();
  if (!id.length() || id.length() > 160 || !title.length() || title.length() > 320) {
    reply(400, "Invalid notification bounds"); return;
  }
  if(autonomous.enabled && !id.startsWith("test-") && !id.startsWith("usb-test-")) {reply(409,"Device owns scheduling");return;}
  bool duplicate = false;
  for (const auto& old : recent) if (old == id) duplicate = true;
  for (const auto& old : queue) if (old.id == id) duplicate = true;
  for (const auto& event : events) if (event.notificationId == id) duplicate = true;
  if (!duplicate) {
    if (queue.size() >= QUEUE_LIMIT) { reply(429, "Queue full"); return; }
    queue.push_back({id, title, chime});
    if (!saveQueue()) { queue.pop_back(); reply(507, "Queue could not be persisted"); return; }
  }
  DynamicJsonDocument ack(512);
  ack["protocol"] = 4; ack["id"] = id; ack["accepted"] = true; ack["duplicate"] = duplicate;
  String response; serializeJson(ack, response); server.send(200, "application/json", response);
}
void listEvents() {
  if (!authorize()) return;
  if (!queueHealthy) { reply(503, "Persistent queue is corrupt"); return; }
  DynamicJsonDocument doc(49152);
  doc["protocol"] = 4;
  JsonArray actions = doc["events"].to<JsonArray>();
  for (const auto& event : events) {
    JsonObject obj = actions.createNestedObject();
    obj["id"] = event.id; obj["notificationId"] = event.notificationId; obj["action"] = event.action;
    if (event.action == "snoozed") obj["minutes"] = event.minutes;
    if (event.job.length()) { DynamicJsonDocument snapshot(1536); deserializeJson(snapshot,event.job); obj["job"].set(snapshot); }
    if (event.deferred.length()) { DynamicJsonDocument snapshot(1536); deserializeJson(snapshot,event.deferred); obj["deferred"].set(snapshot); }
  }
  if (doc.overflowed()) { reply(507, "Events could not be serialized"); return; }
  String body; serializeJson(doc, body); server.send(200, "application/json", body);
}
void acknowledgeEvents() {
  if (!authorize()) return;
  if (!queueHealthy) { reply(503, "Persistent queue is corrupt"); return; }
  const String body = server.arg("plain");
  if (body.length() > 2048) { reply(413, "Payload too large"); return; }
  DynamicJsonDocument doc(4096);
  if (deserializeJson(doc, body) || !doc["ids"].is<JsonArray>() || doc["ids"].size() > EVENT_LIMIT) {
    reply(400, "Invalid event acknowledgement"); return;
  }
  for (JsonVariant id : doc["ids"].as<JsonArray>()) {
    if (!id.is<String>() || id.as<String>().length() != 32) { reply(400, "Invalid event ID"); return; }
  }
  const auto oldEvents = events;
  for (JsonVariant id : doc["ids"].as<JsonArray>()) {
    for (auto it = events.begin(); it != events.end();) {
      if (it->id == id.as<String>()) it = events.erase(it); else ++it;
    }
  }
  if (events.size() != oldEvents.size() && !saveQueue()) {
    events = oldEvents; reply(507, "Event acknowledgement could not be persisted"); return;
  }
  // Repeated acknowledgements also succeed after a lost HTTP response.
  doc["protocol"] = 4; doc["acknowledged"] = doc["ids"]; doc.remove("ids");
  String response; serializeJson(doc, response); server.send(200, "application/json", response);
}
void drawLines(const String& text, size_t page) {
  oled.clearBuffer();
  oled.setFont(MASA_OLED_FONT); // Latin Extended includes all Turkish letters.
  // Count Unicode characters, never cut a UTF-8 sequence at a row/page boundary.
  oled.setClipWindow(OLED_X_OFFSET, OLED_Y_OFFSET, OLED_X_OFFSET + 72, OLED_Y_OFFSET + 40);
  for (size_t line = 0; line < masa::OLED_ROWS; line++) {
    const size_t position = page * masa::OLED_PAGE_CHARACTERS + line * masa::OLED_COLUMNS;
    size_t offset = masa::characterOffset(text.c_str(), text.length(), position);
    if (offset >= text.length()) break;
    String row;
    for (size_t column = 0; column < masa::OLED_COLUMNS && offset < text.length(); ++column) {
      const auto character = masa::nextCharacter(text.c_str() + offset, text.length() - offset);
      if (character.codepoint >= 32 && character.codepoint <= 0xFFFF &&
          character.codepoint != 0xFFFD && u8g2_IsGlyph(oled.getU8g2(), character.codepoint))
        row.concat(text.c_str() + offset, character.bytes);
      else row += '?';
      offset += character.bytes;
    }
    oled.drawUTF8(OLED_X_OFFSET, OLED_Y_OFFSET + 11 + line * 13, row.c_str());
  }
  oled.sendBuffer();
}
String randomKey() {
  char key[33];
  snprintf(key, sizeof(key), "%08lx%08lx%08lx%08lx", (unsigned long)esp_random(),
           (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
  return String(key);
}
void printStatus() {
  Serial.println("Masa firmware 0.7.0 | ESP32-C3 | passive buzzer GPIO " + String(BUZZER_PIN));
  Serial.println("Pending button events: " + String(events.size()));
  Serial.println("Sound task: " + String(soundCommands ? "ready" : "unavailable"));
  Serial.println("OLED I2C: " + String(oledPresent ? "detected at 0x3C" : "not detected"));
  oled.setFont(MASA_OLED_FONT);
  const uint16_t turkish[] = {0xC7, 0xE7, 0x11E, 0x11F, 0x130, 0x131, 0xD6, 0xF6, 0x15E, 0x15F, 0xDC, 0xFC};
  size_t glyphs = 0;
  for (auto codepoint : turkish) glyphs += u8g2_IsGlyph(oled.getU8g2(), codepoint) != 0;
  Serial.println("OLED UTF-8 Turkish glyphs: " + String(glyphs) + "/12");
  if (setupMode) {
    Serial.println("Setup Wi-Fi: " + setupSsid);
    Serial.println("Setup auth: open (no password)");
    Serial.println("Setup URL: http://192.168.4.1");
    Serial.println("Wi-Fi manager: AyresWiFiManager 2.3.0");
  } else {
    Serial.println("Masa IP: http://" + WiFi.localIP().toString());
  }
  Serial.println("Wi-Fi state: " + String(AyresWiFiManager::stateToString(wifiManager.getState())));
  Serial.println("Device key: " + deviceToken);
}
void startSetup() {
  if (!filesystemReady) {Serial.println("Filesystem recovery required; preserving partition");return;}
  if (wifiManager.isPortalActive()) return;
  if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
  if (apiStarted) { server.stop(); apiStarted = false; }
  // The portal and notification API share port 80; only one may own it.
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false);
  wifiManager.openPortal();
  setupMode = wifiManager.isPortalActive();
  lastDraw = 0;
  printStatus();
}

bool writePortalFile(const char* path, const String& contents) {
  File existing = LittleFS.open(path, "r");
  if (existing) {
    const bool same = existing.readString() == contents;
    existing.close();
    if (same) return true;
  }
  const String temporary = String(path) + ".tmp";
  File file = LittleFS.open(temporary, "w");
  if (!file) return false;
  const size_t written = file.print(contents); file.close();
  if (written != contents.length()) { LittleFS.remove(temporary); return false; }
  return LittleFS.rename(temporary, path);
}

void preparePortalStorage() {
  // NVS notices and device key use another partition and remain unchanged.
  if (!filesystemReady) { Serial.println("Portal storage unavailable"); return; }
  // Import once, never overwrite credentials later saved by Ayres. Keep the NVS
  // original for rollback; the marker prevents resurrecting Wi-Fi after an erase.
  if (!LittleFS.exists("/wifi.json") && !preferences.getBool("ayresimported", false)) {
    String ssid = WIFI_SSID, password = WIFI_PASSWORD;
    const String saved = preferences.getString("wifi", "");
    DynamicJsonDocument credentials(512);
    if (saved.length()) {
      if (!deserializeJson(credentials, saved) && credentials["ssid"].is<String>() && credentials["password"].is<String>()) {
        ssid = credentials["ssid"].as<String>(); password = credentials["password"].as<String>();
      } else { ssid = ""; Serial.println("Legacy Wi-Fi unreadable; opening portal"); }
    }
    if (ssid.length() && ssid != "YOUR_WIFI_SSID") {
      credentials.clear(); credentials["ssid"] = ssid; credentials["password"] = password;
      String data; serializeJson(credentials, data);
      if (writePortalFile("/wifi.json", data)) {
        preferences.putBool("ayresimported", true);
        Serial.println("Legacy Wi-Fi imported; NVS backup retained");
      } else Serial.println("Legacy Wi-Fi import failed; NVS backup retained");
    } else preferences.putBool("ayresimported", true);
  } else if (LittleFS.exists("/wifi.json")) preferences.putBool("ayresimported", true);
  LittleFS.mkdir("/masa");
  String page = FPSTR(SETUP_PAGE); page.replace("__MASA_DEVICE_KEY__", deviceToken);
  if (!writePortalFile("/masa/index.html", page)) Serial.println("Portal page unavailable; using Ayres default");
  writePortalFile("/masa/success.html", F("<!doctype html><meta charset=utf-8><title>Masa</title><p>Kaydedildi. Cihaz yeniden başlıyor. Bilgisayarını kendi Wi-Fi ağına bağla; Masa'da bağlantıyı kontrol et.</p>"));
}

void handleSerial() {
  static String command;
  while (Serial.available()) {
    const char ch = Serial.read();
    if (ch == '\n') {
      command.trim();
      if (command == "INFO") printStatus();
      else if (command == "SETUP") startSetup();
      else if (command == "SCAN" && setupMode) {
        if (xTaskCreate(scanPortalTask, "ayres-scan-test", 8192, nullptr, 1, nullptr) != pdPASS) Serial.println("Scan test could not start");
      }
      else if (command == "TEST") {
        if (queue.size() < QUEUE_LIMIT && queueHealthy) {
          const String id = "usb-test-" + randomKey();
          queue.push_back({id, "Çç Ğğ İı Öö Şş Üü Türkçe testi", true});
          if (saveQueue()) Serial.println("USB test queued: " + id);
          else { queue.pop_back(); Serial.println("USB test storage failed"); }
        } else Serial.println("USB test queue unavailable");
      }
      command = "";
    } else if (ch != '\r') {
      if (command.length() < 16) command += ch;
      else command = "";
    }
  }
}
#include "autonomous_runtime.h"

void finishNotice(const char* action = nullptr) {
  if (queue.empty()) return;
  setSound(false);
  if (action && events.size() >= EVENT_LIMIT) {
    actionFeedback = "İşlem deposuDolu.       Masa'yı aç."; feedbackSince = millis();
    activeSince = millis(); lastDraw = 0; return;
  }
  const auto oldQueue = queue;
  const auto oldRecent = recent;
  const auto oldEvents = events;
  const auto oldAutonomous=autonomous;
  if (action && !recordAutonomousAction(action)) {
    actionFeedback="İşlem için  Saat/depo   bekleniyor";feedbackSince=millis();lastDraw=0;return;
  }
  recent.push_back(queue.front().id);
  if (recent.size() > RECENT_LIMIT) recent.pop_front();
  queue.pop_front();
  if (!saveQueue()) {
    queue = oldQueue; recent = oldRecent; events = oldEvents;autonomous=oldAutonomous;
    Serial.println("Queue save failed; keeping notification for retry");
    actionFeedback = "KaydedilemediTekrar dene."; feedbackSince = millis();
    lastDraw = 0;
    activeSince = millis(); // Bound storage retries to the display interval.
    return;
  }
  active = false; lastDraw = 0;
  if (action) {
    actionFeedback = String(action) == "completed" ? "Yapıldı.    Masa'ya     aktarılacak." : autonomous.enabled ? "15 dakika   ertelendi." : "15 dakika   ertele.     Masa'yı aç.";
    feedbackSince = millis();
  }
}
void setup() {
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  if (ledcSetup(BUZZER_CHANNEL, 2000, 10)) {
    ledcAttachPin(BUZZER_PIN, BUZZER_CHANNEL); ledcWrite(BUZZER_CHANNEL, 0);
    soundCommands = xQueueCreate(1, sizeof(uint8_t));
    if (soundCommands && xTaskCreate(soundTask, "masa-sound", 2048, nullptr, 2, nullptr) != pdPASS) {
      vQueueDelete(soundCommands); soundCommands = nullptr;
    }
  }
  pinMode(ACK_BUTTON_PIN, INPUT_PULLUP);
  Serial.begin(115200);
  oled.setI2CAddress(OLED_ADDRESS * 2); oled.begin(); oled.setContrast(180);
  Wire.beginTransmission(OLED_ADDRESS); oledPresent = Wire.endTransmission() == 0;
  storageReady = preferences.begin("masa", false);
  filesystemReady=LittleFS.begin(false);
  if(!filesystemReady) {
    // First boot may have a completely erased partition. Initialize only after
    // checking every byte; a damaged existing filesystem is never auto-erased.
    const esp_partition_t* partition=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_ANY,"spiffs");
    bool blank=partition!=nullptr;uint8_t bytes[256];
    if(partition)for(size_t offset=0;blank&&offset<partition->size;offset+=sizeof(bytes)) {
      size_t length=std::min(sizeof(bytes),size_t(partition->size-offset));
      if(esp_partition_read(partition,offset,bytes,length)!=ESP_OK){blank=false;break;}
      for(size_t i=0;i<length;++i)if(bytes[i]!=0xFF){blank=false;break;}
    }
    if(blank&&LittleFS.format())filesystemReady=LittleFS.begin(false);
    if(!filesystemReady)Serial.println("Existing LittleFS unavailable; preserving partition for recovery");
  }
  queueHealthy = storageReady && filesystemReady && loadQueue();
  if(queueHealthy && !LittleFS.exists("/masa-state.json")) queueHealthy=saveQueue();
  if (!queueHealthy) { queue.clear(); recent.clear(); events.clear(); Serial.println("Persistent queue could not be read; refusing new notifications"); }
  // Ayres begins with auto-format-on-failure. Do not invoke it while an existing
  // filesystem is unreadable: preserve its bytes for recovery instead.
  if (!filesystemReady) {drawLines("Depo hatası Kurtarma    gerekiyor",0);return;}
  WiFi.persistent(false); WiFi.setHostname(DEVICE_HOSTNAME); WiFi.setAutoReconnect(true);
  // Start the RF entropy source before generating persistent authentication keys.
  WiFi.mode(WIFI_STA);
  deviceToken = preferences.getString("devicekey", DEVICE_TOKEN);
  if (deviceToken.length() < 24 || deviceToken.startsWith("CHANGE_ME")) {
    deviceToken = randomKey();
    if (!storageReady || preferences.putString("devicekey", deviceToken) != deviceToken.length()) {
      deviceToken = ""; Serial.println("Device key could not be persisted");
    }
  }
  String mac = WiFi.macAddress(); mac.replace(":", "");
  setupSsid = "Masa-" + mac.substring(mac.length() - 4);
  wifiManager.setHostname(DEVICE_HOSTNAME);
  wifiManager.setAPCredentials(setupSsid, "");
  wifiManager.setHtmlPathPrefix("/masa/");
  wifiManager.setPortalTimeout(0); // Setup remains available until credentials are saved.
  wifiManager.enableButtonPortal(false);
  wifiManager.setLedAuto(false);
  wifiManager.setLedPatternManual(AyresWiFiManager::LedPattern::OFF);
  wifiManager.setFallbackPolicy(AyresWiFiManager::FallbackPolicy::NO_CREDENTIALS_ONLY);
  wifiManager.setReconnectBackoffMs(30000);
  preparePortalStorage();
  wifiManager.begin();
  // Avoid run(): its BOOT hold erases Wi-Fi and its Internet time sync is not
  // used here: our own callback establishes trusted scheduler time. Use the public connection API.
  if (!wifiManager.connectToWiFi()) startSetup();
  const char* headers[] = {"Authorization"}; server.collectHeaders(headers, 1);
  server.on("/api/health", HTTP_GET, health);
  server.on("/api/notify", HTTP_POST, notify);
  server.on("/api/events", HTTP_GET, listEvents);
  server.on("/api/events/ack", HTTP_POST, acknowledgeEvents);
  server.on("/api/schedule", HTTP_GET, getSchedule);
  server.on("/api/schedule", HTTP_POST, putSchedule);
  sntp_set_time_sync_notification_cb([](struct timeval*) {clockTrusted=true;});
  configTime(0,0,"pool.ntp.org","time.google.com");
  setenv("TZ",autonomous.timezone.c_str(),1);tzset();
  server.onNotFound([] { reply(404, "Not found"); });
  if (!setupMode) { server.begin(); apiStarted = true; }
  drawLines("Masa        Wi-Fi       bekleniyor", 0);
}
void loop() {
  const uint32_t now = millis();
  if(!filesystemReady){handleSerial();delay(10);return;}
  handleSerial();
  tickAutonomous();
  wifiManager.update();
  setupMode = wifiManager.isPortalActive();
  if (!setupMode) wifiManager.reintentarConexionSiNecesario();
  if (!setupMode && WiFi.status() == WL_CONNECTED) {
    hasConnected = true;
    lastConnected = now;
    if (!apiStarted) { server.begin(); apiStarted = true; }
    if (!mdnsStarted) {
      mdnsStarted = MDNS.begin(DEVICE_HOSTNAME);
      if (mdnsStarted) MDNS.addService("http", "tcp", 80);
      Serial.print("Masa IP: http://"); Serial.println(WiFi.localIP());
    }
    server.handleClient();
  } else if (!setupMode) {
    if (mdnsStarted) { MDNS.end(); mdnsStarted = false; }
    if (!hasConnected && now - lastConnected >= 60000) startSetup();
  }
  const bool wasBusy = buttonGesture.busy();
  const auto buttonAction = buttonGesture.update(digitalRead(ACK_BUTTON_PIN) == LOW, now);
  if (!wasBusy && buttonGesture.busy()) {
    idleState.wake(now);oled.setPowerSave(0);oled.setContrast(180);lastDraw=0;
    buttonNoticeId = active && !queue.empty() ? queue.front().id : "";
    if (active) setSound(false);
  }
  if (buttonAction == masa::ButtonAction::Setup) startSetup();
  else if (buttonAction != masa::ButtonAction::None && active && !queue.empty() && buttonNoticeId == queue.front().id) {
    if (buttonAction == masa::ButtonAction::Complete) finishNotice("completed");
    else if (buttonAction == masa::ButtonAction::Snooze) finishNotice("snoozed");
    else finishNotice();
  }
  const bool feedback = actionFeedback.length() && millis() - feedbackSince < 2500;
  if (!feedback) actionFeedback = "";
  if (!active && !queue.empty() && !buttonGesture.busy() && !feedback) {
    active = true; activeSince = now; lastDraw = 0;idleState.wake(now);oled.setPowerSave(0);oled.setContrast(180);
    setSound(queue.front().chime && noticeSoundAllowed());
  }
  if (feedback) {
    if (!lastDraw || now - lastDraw >= 200) { drawLines(actionFeedback, 0); lastDraw = now; }
  } else if (active) {
    const auto& notice = queue.front();
    const uint32_t elapsed = now - activeSince;
    const size_t pages = masa::pageCount(notice.title.c_str(), notice.title.length());
    if (!lastDraw || now - lastDraw >= 200) { drawLines(notice.title, (elapsed / 3500) % pages); lastDraw = now; }
    if (elapsed >= max(uint32_t(10000), uint32_t(pages * 3500))) {
      if (!buttonGesture.busy() && !feedback) finishNotice();
    }
  } else if (!lastDraw || now - lastDraw >= 1000) {
    if (setupMode) {
      String label = setupSsid;
      while (label.length() < 12) label += ' ';
      drawLines((now / 5000) % 2 == 0 ? label + "Şifresiz    Wi-Fi kur" : "Tarayıcı:   192.168.4.1 Wi-Fi seç", 0);
    }
    else drawIdle(now);
    lastDraw = now;
  }
  delay(2);
}
