"""Synthetic parent that exits after creating a TERM-ignoring descendant."""

from pathlib import Path
import subprocess
import sys

child = subprocess.Popen([sys.executable, Path(__file__).with_name("ignore_term_child.py")])
Path(sys.argv[1]).write_text(str(child.pid), encoding="utf-8")
raise SystemExit(0)
