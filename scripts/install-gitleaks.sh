#!/usr/bin/env bash
set -euo pipefail
version=8.30.0
case "$(uname -s)-$(uname -m)" in
 Darwin-arm64) platform=darwin_arm64;;
 Linux-x86_64) platform=linux_x64;;
 *) echo 'Install gitleaks from its official releases for this platform' >&2; exit 1;;
esac
mkdir -p .orca-scratch/tools
base="https://github.com/gitleaks/gitleaks/releases/download/v${version}"
archive="gitleaks_${version}_${platform}.tar.gz"
curl -fsSL "$base/$archive" -o ".orca-scratch/tools/$archive"
curl -fsSL "$base/gitleaks_${version}_checksums.txt" -o .orca-scratch/tools/checksums.txt
python3 - "$archive" <<'PY'
import hashlib,sys
from pathlib import Path
root=Path('.orca-scratch/tools'); name=sys.argv[1]
expected=next(line.split()[0] for line in (root/'checksums.txt').read_text().splitlines() if line.split()[-1]==name)
assert hashlib.sha256((root/name).read_bytes()).hexdigest()==expected, 'gitleaks checksum mismatch'
PY
tar -xzf ".orca-scratch/tools/$archive" -C .orca-scratch/tools gitleaks
.orca-scratch/tools/gitleaks version
