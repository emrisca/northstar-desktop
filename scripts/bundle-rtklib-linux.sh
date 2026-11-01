#!/bin/sh
# Build the pinned RTKLIB release for Linux and put it in the app's bundle.
#
# The macOS and Windows tools are committed because their builds are awkward to
# reproduce everywhere. Linux binaries are tied to the distribution's glibc and
# WebKit stack, so they are built inside the release runner instead of being
# checked in. The archive is the same pinned 2.4.3 b34 release the recovery
# installer downloads, and its SHA-256 is checked before anything is unpacked.
#
# Usage:
#   scripts/bundle-rtklib-linux.sh
#
# The script needs curl (or wget), unzip, make and a C compiler. It writes
# src-tauri/resources/rtklib/linux/ with both tools, the licence and the
# BUNDLED.json record the readiness check reads.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
URL="https://github.com/tomojitakasu/RTKLIB/releases/download/v2.4.3-b34/RTKLIB_2.4.3_b34.zip"
EXPECTED="5f2eacee05e9f90cdc3604e48a906222c8832000056be9000f7ee3627bb18874"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/northstar-rtklib.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 --output "$WORK/rtklib.zip" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$WORK/rtklib.zip" "$URL"
else
  echo "Neither curl nor wget is available; the RTKLIB archive cannot be downloaded." >&2
  exit 1
fi

ACTUAL=$(hash_file "$WORK/rtklib.zip")
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "RTKLIB archive checksum mismatch: expected $EXPECTED, got $ACTUAL." >&2
  exit 1
fi

mkdir -p "$WORK/source"
unzip -q "$WORK/rtklib.zip" -d "$WORK/source"
ROOT=$(find "$WORK/source" -mindepth 1 -maxdepth 2 -type d -name app -exec dirname {} \; | head -1)
if [ -z "$ROOT" ] || [ ! -d "$ROOT/app/consapp" ]; then
  echo "The RTKLIB archive did not contain app/consapp." >&2
  exit 1
fi

make -C "$ROOT/app/consapp/rnx2rtkp/gcc"
make -C "$ROOT/app/consapp/convbin/gcc"

RNX=$(find "$ROOT/app/consapp/rnx2rtkp" -type f -name rnx2rtkp -perm -u+x | head -1)
CONV=$(find "$ROOT/app/consapp/convbin" -type f -name convbin -perm -u+x | head -1)
if [ -z "$RNX" ] || [ -z "$CONV" ]; then
  echo "The RTKLIB build produced no rnx2rtkp or convbin executable." >&2
  exit 1
fi

LICENSE=$(find "$ROOT" -maxdepth 3 -type f \( -iname 'LICENSE.txt' -o -iname 'LICENSE' \) | head -1)
if [ -z "$LICENSE" ]; then
  echo "The RTKLIB archive has no licence file; the BSD licence must travel with the tools." >&2
  exit 1
fi

mkdir -p "$WORK/stage/bin"
cp "$RNX" "$WORK/stage/bin/rnx2rtkp"
cp "$CONV" "$WORK/stage/bin/convbin"
chmod 755 "$WORK/stage/bin/rnx2rtkp" "$WORK/stage/bin/convbin"
cp "$LICENSE" "$WORK/stage/LICENSE.txt"

"$REPO/scripts/bundle-rtklib.sh" --platform linux "$WORK/stage"
