"""Synthetic command checks the explicit environment, without recording values."""

import os
from pathlib import Path
import sys

expected = {"NETSENSE_ALLOWED": "synthetic", "LC_CTYPE": "C.UTF-8"}
actual = dict(os.environ)
# macOS injects this runtime variable even when exec receives an empty env.
if sys.platform == "darwin":
    actual.pop("__CF_USER_TEXT_ENCODING", None)
Path(sys.argv[1]).write_text("exact" if actual == expected else "mismatch")
