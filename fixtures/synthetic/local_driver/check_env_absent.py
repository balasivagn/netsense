"""Synthetic child program: records only whether a named variable exists."""

from pathlib import Path
import os
import sys

value = "present" if sys.argv[2] in os.environ else "absent"
Path(sys.argv[1]).write_text(value, encoding="utf-8")
