"""Synthetic descendant: ignores TERM so group cleanup must escalate."""

import signal
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
while True:
    time.sleep(1)
