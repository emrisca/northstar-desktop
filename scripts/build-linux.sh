#!/bin/sh
# Build Northstar for Linux and leave the .deb and AppImage behind.
#
# The release runner runs the same steps. This script is for a developer machine
# and for reproducing a release artifact: it checks the WebKit/GTK and RTKLIB
# build prerequisites, builds the pinned Linux RTKLIB bundle, runs the full test
# command, packages the app, and checks the artifact.
#
# Usage:
#   scripts/build-linux.sh
#   scripts/build-linux.sh --skip-tests
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
SKIP_TESTS=0
if [ "${1:-}" = "--skip-tests" ]; then
  SKIP_TESTS=1
elif [ "$#" -gt 0 ]; then
  echo "Usage: scripts/build-linux.sh [--skip-tests]" >&2
  exit 1
fi

for command in node npm cargo rustc make cc pkg-config; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing $command. Install Node 20+, Rust, build-essential and pkg-config." >&2
    exit 1
  fi
done
if ! pkg-config --exists webkit2gtk-4.1; then
  echo "The WebKitGTK 4.1 development files are missing." >&2
  echo "Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev patchelf" >&2
  exit 1
fi

echo 'Installing the pinned npm packages...'
npm ci

echo 'Building the Linux RTKLIB bundle...'
scripts/bundle-rtklib-linux.sh

if [ "$SKIP_TESTS" -eq 0 ]; then
  echo 'Running the frontend and Rust tests...'
  npm test
fi

echo 'Building the .deb and AppImage...'
npm run build:linux

echo 'Checking the packaged artifact and resources...'
npm run verify:package

echo
echo 'Packaged artifacts:'
find src-tauri/target/release/bundle -maxdepth 3 -type f \( -name '*.deb' -o -name '*.AppImage' \) -print
