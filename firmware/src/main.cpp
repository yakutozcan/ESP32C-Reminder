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
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <deque>
#include "setup_page.h"
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
std::deque<Notice> queue;
std::deque<String> recent;
constexpr size_t QUEUE_LIMIT = 8;
constexpr size_t RECENT_LIMIT = 32;
bool active = false;
bool mdnsStarted = false;
bool hasConnected = false;
bool storageReady = false;
bool queueHealthy = true;
bool oledPresent = false;
uint32_t activeSince = 0, lastDraw = 0, lastConnected = 0;
int lastButton = HIGH;
uint32_t buttonChanged = 0;
bool pressed = false;
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

String displayText(String text) {
  const char* from[] = {"ç", "Ç", "ğ", "Ğ", "ı", "İ", "ö", "Ö", "ş", "Ş", "ü", "Ü"};
  const char* to[] = {"c", "C", "g", "G", "i", "I", "o", "O", "s", "S", "u", "U"};
  for (size_t i = 0; i < 12; i++) text.replace(from[i], to[i]);
  String ascii;
  for (size_t i = 0; i < text.length(); i++) {
    unsigned char c = text[i];
    if (c >= 32 && c <= 126) ascii += char(c);
    else if ((c & 0xC0) != 0x80) ascii += '?';
  }
  return ascii;
}
bool saveQueue() {
  if (!storageReady) return false;
  DynamicJsonDocument doc(16384);
  JsonArray pending = doc["pending"].to<JsonArray>();
  for (const auto& notice : queue) {
    JsonObject obj = pending.createNestedObject();
    obj["id"] = notice.id; obj["title"] = notice.title; obj["melody"] = notice.chime ? "chime" : "none";
  }
  JsonArray seen = doc["recent"].to<JsonArray>();
  for (const auto& id : recent) seen.add(id);
  if (doc.overflowed()) return false;
  String data;
  serializeJson(doc, data);
  return preferences.putString("queue", data) == data.length();
}
bool loadQueue() {
  const String data = preferences.getString("queue", "");
  if (!data.length()) return true;
  DynamicJsonDocument doc(16384);
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
  return true;
}
void reply(int code, const char* message) {
  DynamicJsonDocument doc(256);
  doc["protocol"] = 2; doc["error"] = message;
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
  doc["protocol"] = 2; doc["name"] = "Masa ESP32-C3"; doc["firmware"] = "0.2.2";
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
  bool duplicate = false;
  for (const auto& old : recent) if (old == id) duplicate = true;
  for (const auto& old : queue) if (old.id == id) duplicate = true;
  if (!duplicate) {
    if (queue.size() >= QUEUE_LIMIT) { reply(429, "Queue full"); return; }
    queue.push_back({id, displayText(title), chime});
    if (!saveQueue()) { queue.pop_back(); reply(507, "Queue could not be persisted"); return; }
  }
  DynamicJsonDocument ack(512);
  ack["protocol"] = 2; ack["id"] = id; ack["accepted"] = true; ack["duplicate"] = duplicate;
  String response; serializeJson(ack, response); server.send(200, "application/json", response);
}
void drawLines(const String& text, size_t page) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_tf);
  // 12 characters x 3 lines; clipping confines drawing to the visible window.
  oled.setClipWindow(OLED_X_OFFSET, OLED_Y_OFFSET, OLED_X_OFFSET + 72, OLED_Y_OFFSET + 40);
  for (size_t line = 0; line < 3; line++) {
    const size_t offset = page * 36 + line * 12;
    if (offset >= text.length()) break;
    oled.drawStr(OLED_X_OFFSET, OLED_Y_OFFSET + 10 + line * 11, text.substring(offset, offset + 12).c_str());
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
  Serial.println("Masa firmware 0.2.2 | ESP32-C3 | passive buzzer GPIO " + String(BUZZER_PIN));
  Serial.println("Sound task: " + String(soundCommands ? "ready" : "unavailable"));
  Serial.println("OLED I2C: " + String(oledPresent ? "detected at 0x3C" : "not detected"));
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
  if (!LittleFS.begin(true)) { Serial.println("Portal storage unavailable"); return; }
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
          queue.push_back({id, "Masa hazir. Kisa melodi testi.", true});
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
void finishNotice() {
  if (queue.empty()) return;
  setSound(false);
  const auto oldQueue = queue;
  const auto oldRecent = recent;
  recent.push_back(queue.front().id);
  if (recent.size() > RECENT_LIMIT) recent.pop_front();
  queue.pop_front();
  if (!saveQueue()) {
    queue = oldQueue; recent = oldRecent;
    Serial.println("Queue save failed; keeping notification for retry");
    activeSince = millis(); // Bound storage retries to the display interval.
    return;
  }
  active = false; lastDraw = 0;
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
  queueHealthy = storageReady && loadQueue();
  if (!queueHealthy) { queue.clear(); Serial.println("Persistent queue could not be read; refusing new notifications"); }
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
  // needed for desktop-scheduled reminders. Use the public connection API.
  if (!wifiManager.connectToWiFi()) startSetup();
  const char* headers[] = {"Authorization"}; server.collectHeaders(headers, 1);
  server.on("/api/health", HTTP_GET, health);
  server.on("/api/notify", HTTP_POST, notify);
  server.onNotFound([] { reply(404, "Not found"); });
  if (!setupMode) { server.begin(); apiStarted = true; }
  drawLines("Masa        Wi-Fi       bekleniyor", 0);
}
void loop() {
  const uint32_t now = millis();
  handleSerial();
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
  if (!active && !queue.empty()) {
    active = true; activeSince = now; lastDraw = 0;
    setSound(queue.front().chime);
  }
  if (active) {
    const auto& notice = queue.front();
    const uint32_t elapsed = now - activeSince;
    const size_t pages = max(size_t(1), (notice.title.length() + 35) / 36);
    if (!lastDraw || now - lastDraw >= 200) { drawLines(notice.title, (elapsed / 3500) % pages); lastDraw = now; }
    if (elapsed >= max(uint32_t(10000), uint32_t(pages * 3500))) finishNotice();
  } else if (!lastDraw || now - lastDraw >= 1000) {
    if (setupMode) {
      String label = setupSsid;
      while (label.length() < 12) label += ' ';
      drawLines((now / 5000) % 2 == 0 ? label + "Sifresiz    Wi-Fi kur" : "Tarayici:   192.168.4.1 Wi-Fi sec", 0);
    }
    else drawLines(!queueHealthy ? "Depo hatasi Seri monitor kontrol et" : WiFi.status() == WL_CONNECTED ? "Masa hazir  Notlarin    bekleniyor" : "Masa        Wi-Fi       bekleniyor", 0);
    lastDraw = now;
  }
  const int button = digitalRead(ACK_BUTTON_PIN);
  if (button != lastButton) { lastButton = button; buttonChanged = now; }
  if (now - buttonChanged >= 40) {
    if (button == LOW && !pressed) { pressed = true; if (active) finishNotice(); }
    if (button == LOW && now - buttonChanged >= 5000 && !setupMode) startSetup();
    if (button == HIGH) pressed = false;
  }
  delay(2);
}
