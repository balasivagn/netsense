"""Synthetic descendant: ignores TERM so group cleanup must escalate."""

import os
from pathlib import Path
import sys
import signal
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
while True:
    time.sleep(1)
