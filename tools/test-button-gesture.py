"""Run firmware button timing tests without an ESP32 or Arduino runtime."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="masa-button-test-") as directory:
    executable = Path(directory) / "button-test"
    subprocess.run(["c++", "-std=c++11", "-Wall", "-Wextra", "-Werror", "-I",
                    str(root / "firmware/include"), str(root / "firmware/test/button_gesture_test.cpp"),
                    "-o", str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
