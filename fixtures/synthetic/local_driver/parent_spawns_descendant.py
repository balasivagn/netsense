"""Synthetic parent that exits after creating a TERM-ignoring descendant."""

from pathlib import Path
import subprocess
import sys
import time

subprocess.Popen(
    [sys.executable, Path(__file__).with_name("ignore_term_child.py"), sys.argv[1]]
)
while not Path(sys.argv[1]).exists():
    time.sleep(0.005)
raise SystemExit(0)
