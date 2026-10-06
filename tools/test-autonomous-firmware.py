"""Verify firmware calendar, idle display timing and atomic storage without hardware."""
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="masa-autonomous-test-") as directory:
    executable = Path(directory) / "autonomous-test"
    subprocess.run(["c++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-I",
                    str(root / "firmware/include"), str(root / "firmware/test/autonomous_clock_test.cpp"),
                    "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)

    dependency = root / "firmware/.pio/libdeps/esp32-c3-oled/ArduinoJson/src"
    if not dependency.is_dir():
        raise SystemExit("Build firmware first (pio run -d firmware) to resolve pinned ArduinoJson for API tests.")
    runtime_executable = Path(directory) / "autonomous-api-test"
    subprocess.run(["c++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-I",
                    str(root / "firmware/include"), "-I", str(dependency),
                    str(root / "firmware/test/autonomous_runtime_test.cpp"),
                    "-o", str(runtime_executable)], check=True)
    subprocess.run([str(runtime_executable)], check=True)
