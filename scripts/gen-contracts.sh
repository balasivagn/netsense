#!/usr/bin/env bash
set -euo pipefail
pnpm exec tsx scripts/generate-contracts.ts "$@"
