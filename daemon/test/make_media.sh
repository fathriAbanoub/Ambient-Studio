#!/bin/sh
# test/make_media.sh — deterministic test clips for the asset/mux phases.
set -e
DIR="$(dirname "$0")/media"
mkdir -p "$DIR"
# A: high-bitrate 1080p h264/mp4 (typical HD stock-footage bitrate class)
ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=20 -c:v libx264 -preset veryfast -b:v 6M -pix_fmt yuv420p "$DIR/hi_bitrate_1080.mp4"
# B: VP9/WebM source (needs codec transcode at ingest)
ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30:duration=10 -c:v libvpx-vp9 -deadline good -cpu-used 4 -b:v 1M -pix_fmt yuv420p "$DIR/vp9_720.webm"
# D: 4:3 aspect mismatch (needs scale+crop)
ffmpeg -y -hide_banner -loglevel error -f lavfi -i smptebars=size=800x600:rate=25:duration=8 -c:v libx264 -preset veryfast -b:v 1500k -pix_fmt yuv420p "$DIR/ar43_800x600.mp4"
ls -la "$DIR"
