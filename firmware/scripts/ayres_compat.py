"""Build-local fixes for pinned Ayres 2.3.0 / Arduino ESP32 2.0.17.

Never modify the installed framework or library. Fail if upstream code changes,
so a dependency upgrade requires reviewing these small compatibility fixes.
"""
from pathlib import Path


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError("Wi-Fi compatibility patch no longer matches pinned source")
    return source.replace(old, new, 1)


def patch_source(name, source):
    if name == "WiFiScan.cpp":
        # IDF 4.4 added this field; Arduino 2.0.17 leaves it uninitialized.
        return replace_once(source, "wifi_scan_config_t config;",
                            "wifi_scan_config_t config = {};\n    config.home_chan_dwell_time = 30;")
    start = source.index("  // Configurar scan rápido en ESP32")
    end = source.index("\n  if (n < 0)", start)
    # Arduino must own scan lifecycle and records: direct IDF calls race the
    # Arduino event handler, yielding missing results or WIFI_SCAN_FAILED.
    source = source[:start] + "  int n = WiFi.scanNetworks(false, false, false, 300);\n" + source[end:]
    source = replace_once(source, "if (!ssid.isEmpty() && !password.isEmpty()) {",
                          "if (!ssid.isEmpty()) {")
    # Distinguish a driver failure from a successful scan with zero networks.
    source = replace_once(source, 'server.send(200, "application/json", "[]");',
                          'server.send(503, "application/json", "{\\\"error\\\":\\\"scan_failed\\\"}");')
    return replace_once(source, "DynamicJsonDocument doc(2048);", "DynamicJsonDocument doc(8192);")


def register(build_env):
    def middleware(env, node):
        original = Path(node.srcnode().get_abspath())
        source = patch_source(original.name, original.read_text())
        destination = Path(env.subst("$BUILD_DIR")) / "masa-compat" / original.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists() or destination.read_text() != source:
            destination.write_text(source)
        print("Masa Wi-Fi compatibility: " + original.name)
        return env.File(str(destination))

    build_env.AddBuildMiddleware(middleware, "*WiFiScan.cpp")
    build_env.AddBuildMiddleware(middleware, "*AyresWiFiManager.cpp")


if "Import" in globals():
    Import("env")
    register(env)
