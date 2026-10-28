#!/usr/bin/env bash
set -euo pipefail

# Synthetic test-only media. Never used by the production application.
output_dir="${1:-.orca-scratch/synthetic-transcode}"
mkdir -p "$output_dir"

ffmpeg -y -v error -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -pix_fmt yuv420p -c:a aac "$output_dir/sample.mp4"
ffmpeg -y -v error -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libvpx-vp9 -c:a libopus "$output_dir/sample.webm"
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q 'hevc.*libx265'; then
  ffmpeg -y -v error -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx265 -tag:v hvc1 -c:a aac "$output_dir/sample-hevc.mov"
else
  printf '%s\n' 'UNTESTED: this ffmpeg build has no libx265 encoder.' > "$output_dir/sample-hevc.UNTESTED.txt"
fi
