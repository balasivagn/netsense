#!/usr/bin/env bash
set -euo pipefail
scripts/gitleaks.sh git --redact --log-opts='--all'
# Scan tracked and nonignored task source, not dependency caches or disposable downloads.
python3 - <<'PY'
from pathlib import Path
import shutil, subprocess
root=Path('.orca-scratch/secret-tree')
shutil.rmtree(root,ignore_errors=True); root.mkdir(parents=True)
for name in subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z']).decode().split('\0'):
    if name and Path(name).is_file():
        target=root/name; target.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(name,target)
PY
scripts/gitleaks.sh dir .orca-scratch/secret-tree --redact
