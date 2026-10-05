"""Test the actual firmware font and Unicode pagination on macOS/Linux.

Run `pio run -d firmware` first to install the pinned U8g2 dependency.
"""
from pathlib import Path
import re
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
clib = root / "firmware/.pio/libdeps/esp32-c3-oled/U8g2/src/clib"
header = (root / "firmware/include/oled_text.h").read_text()
font = re.search(r"#define MASA_OLED_FONT (\w+)", header).group(1)
source = (clib / "u8g2_fonts.c").read_text(encoding="latin-1")
start = source.index("const uint8_t " + font + "[")
end = source.index(";\n", start) + 2

with tempfile.TemporaryDirectory(prefix="masa-oled-test-") as directory:
    build = Path(directory)
    # Only compile the selected font, preserving its upstream copyright comment.
    selected = source[source.rfind("/*", 0, start):end]
    (build / "font.c").write_text('#include "u8g2.h"\n' + selected)
    objects = []
    for path in (clib / "u8g2_font.c", clib / "u8g2_intersection.c", build / "font.c"):
        target = build / (path.stem + ".o")
        subprocess.run(["cc", "-O2", "-ffunction-sections", "-fdata-sections", "-I", str(clib), "-c", str(path), "-o", str(target)], check=True)
        objects.append(str(target))
    executable = build / "oled-test"
    strip = "-Wl,-dead_strip" if sys.platform == "darwin" else "-Wl,--gc-sections"
    subprocess.run(["c++", "-std=c++11", "-O2", strip, "-I", str(clib), "-I", str(root / "firmware/include"),
                    str(root / "firmware/test/oled_text_test.cpp"), *objects, "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
