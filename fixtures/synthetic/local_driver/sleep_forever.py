"""Synthetic child program: records its PID, then waits indefinitely."""

from pathlib import Path
import os
import sys
import time

Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
while True:
    time.sleep(1)
