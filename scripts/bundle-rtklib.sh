#!/bin/sh
# Copy a built RTKLIB into the desktop app so it runs without a compiler.
#
# Northstar's web build asked the operator to install RTKLIB per project. The
# desktop build carries the two command-line tools with it instead: this script
# takes a build that already works on this machine, copies it into
# `src-tauri/resources/rtklib/<platform>/`, and writes the record the readiness
# check and the installer card read
# (`BUNDLED.json`: version, platform, and a SHA-256 per file).
#
# Usage:
#   scripts/bundle-rtklib.sh [--platform macos|windows|linux] [folder holding bin/rnx2rtkp]
#
# The folder is `<project>/tools/rtklib` in the web build, or any RTKLIB 2.4.3
# b34 build. Building the same version from the pinned archive is what
# `npm run tauri build` would otherwise do on every machine, which is the thing
# this script exists to avoid. Without --platform the host decides; pass it when
# the folder already holds another platform's native binaries, such as the
# official Windows archive unpacked on a Mac.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
PLATFORM=
while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      if [ $# -lt 2 ]; then
        echo "--platform needs a value: macos, windows or linux." >&2
        exit 1
      fi
      PLATFORM=$2
      shift 2
      ;;
    --platform=*) PLATFORM=${1#*=}; shift ;;
    *) break ;;
  esac
done
SOURCE=${1:-"$REPO/../northstar/tools/rtklib"}

if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin) PLATFORM=macos ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
    Linux) PLATFORM=linux ;;
    *) echo "This platform is not supported: $(uname -s)" >&2; exit 1 ;;
  esac
fi
case "$PLATFORM" in
  macos|windows|linux) ;;
  *) echo "Unknown platform: $PLATFORM (expected macos, windows or linux)." >&2; exit 1 ;;
esac

VERSION="2.4.3 b34"
if [ -f "$SOURCE/INSTALLED.json" ]; then
  RECORDED=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE/INSTALLED.json" | head -1)
  if [ -n "$RECORDED" ]; then
    VERSION=$RECORDED
  fi
fi

if [ "$PLATFORM" = windows ]; then
  if [ ! -f "$SOURCE/bin/rnx2rtkp.exe" ] || [ ! -f "$SOURCE/bin/convbin.exe" ]; then
    echo "No Windows RTKLIB build at $SOURCE (expected bin/rnx2rtkp.exe and bin/convbin.exe)." >&2
    exit 1
  fi
elif [ ! -x "$SOURCE/bin/rnx2rtkp" ] || [ ! -x "$SOURCE/bin/convbin" ]; then
  echo "No RTKLIB build at $SOURCE (expected executable bin/rnx2rtkp and bin/convbin)." >&2
  echo "Pass the folder that holds it, for example:" >&2
  echo "  scripts/bundle-rtklib.sh ../northstar/tools/rtklib" >&2
  exit 1
fi
if [ ! -f "$SOURCE/LICENSE.txt" ]; then
  echo "The build has no LICENSE.txt; the BSD license has to travel with the binaries." >&2
  exit 1
fi

DEST="$REPO/src-tauri/resources/rtklib/$PLATFORM"
rm -rf "$DEST"
mkdir -p "$DEST/bin"

if [ "$PLATFORM" = windows ]; then
  cp "$SOURCE/bin/rnx2rtkp.exe" "$SOURCE/bin/convbin.exe" "$DEST/bin/"
  for dll in "$SOURCE"/bin/*.dll; do
    [ -f "$dll" ] && cp "$dll" "$DEST/bin/"
  done
else
  cp "$SOURCE/bin/rnx2rtkp" "$SOURCE/bin/convbin" "$DEST/bin/"
  chmod 755 "$DEST/bin/rnx2rtkp" "$DEST/bin/convbin"
fi
cp "$SOURCE/LICENSE.txt" "$DEST/LICENSE.txt"

hash() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}

{
  printf '{\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "releaseTag": "v2.4.3-b34",\n'
  printf '  "license": "BSD 2-Clause",\n'
  printf '  "platform": "%s",\n' "$PLATFORM"
  printf '  "bundledAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "files": {\n'
  first=1
  for file in "$DEST"/bin/* "$DEST/LICENSE.txt"; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    if [ $first -eq 1 ]; then first=0; else printf ',\n'; fi
    printf '    "%s": "%s"' "$name" "$(hash "$file")"
  done
  printf '\n  }\n'
  printf '}\n'
} > "$DEST/BUNDLED.json"

echo "Bundled RTKLIB $VERSION for $PLATFORM:"
ls -l "$DEST/bin"
echo "$DEST/BUNDLED.json records the hashes."
