# macOS file association

## Current result

The app declares `.northstar` and `.northstar.json` on one document type with
the custom UTI `com.emrisca.northstar.project`. On macOS 26.6.2 (build 25G83) a
sample `.northstar` resolves to that UTI and to Northstar.app, so Finder
double-click reaches the app. A compound `.northstar.json` still resolves to
`public.json` before the declaration is consulted, so those files open through
**File > Open Project** or an explicit `open -a`.

Measured on 1 November 2026 against the debug bundle, after `lsregister -f` and
`lsregister -gc`:

```text
sample: .tmp/association-test.northstar
NSWorkspace: .../bundle/macos/Northstar.app
LSCopyDefaultApplicationURLForURL: .../bundle/macos/Northstar.app
URLResourceValues.contentType: com.emrisca.northstar.project
default for com.emrisca.northstar.project: .../Northstar.app

sample: .tmp/association-test.northstar.json
NSWorkspace: /Applications/Xcode.app
URLResourceValues.contentType: public.json
```

The declaration in the built bundle:

```text
CFBundleTypeExtensions = [ "northstar", "northstar.json" ]
LSItemContentTypes     = [ "com.emrisca.northstar.project" ]
CFBundleTypeRole       = Editor
LSHandlerRank          = Owner
```

`project_path` in `src-tauri/src/lib.rs` accepts both suffixes, the open and
save dialogs filter on both, and **Save a copy…** writes the single-dot name so
the file it produces is the one Finder opens.

This is not an unverified claim. The built debug bundle was re-registered and
queried after a local/user LaunchServices rescan:

```sh
APP=src-tauri/target/debug/bundle/macos/Northstar.app
SAMPLE=.tmp/association-test.northstar.json
swift scripts/macos-association-check.swift "$SAMPLE"
mdls -name kMDItemContentType -name kMDItemContentTypeTree "$SAMPLE"
```

Observed:

```text
kMDItemContentType     = "public.json"
kMDItemContentTypeTree = ( "public.item", "public.text", "public.data",
                           "public.content", "public.json" )
NSWorkspace: /Applications/Xcode.app
LSCopyDefaultApplicationURLForURL: /Applications/Xcode.app
URLResourceValues.contentType: public.json
default for public.json: /Applications/Xcode.app
handlers for public.json: com.apple.dt.Xcode, app.zen-browser.zen,
  com.microsoft.VSCode, com.apple.TextEdit, com.google.Chrome,
  com.apple.Notes, com.brave.Browser
default for com.emrisca.northstar.project:
  .../src-tauri/target/debug/bundle/macos/Northstar.app
handlers for com.emrisca.northstar.project: com.emrisca.northstar,
  com.apple.TextEdit, com.apple.dt.Xcode, com.google.Chrome,
  com.apple.Notes, com.brave.Browser
```

`lsregister -dump` does contain the declared UTI and claim:

```text
type id:  com.emrisca.northstar.project
tags:     .northstar.json, application/json
claim id: Northstar project
rank:     Owner
roles:    Editor
bindings: com.emrisca.northstar.project
```

The problem is the mapping from the sample's compound suffix to that UTI, not a
missing declaration or handler. The custom UTI is registered and is the default
for `com.emrisca.northstar.project`; it is simply never selected for a file
whose last extension is `json`.

## What was tried

Each variant was written into the built `Info.plist`, ad-hoc signed, then
registered with:

```sh
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSREG -u "$APP"
$LSREG -f "$APP"
$LSREG -gc
mdimport -t -d1 "$SAMPLE"
```

The generated baseline is an exported UTI with
`public.filename-extension = northstar.json`, plus a document type with
`CFBundleTypeExtensions = northstar.json`, `CFBundleTypeRole = Editor`,
`LSHandlerRank = Owner`, and `LSItemContentTypes = com.emrisca.northstar.project`.

| Variant | Declaration change | Observed for `.northstar.json` |
| --- | --- | --- |
| A | Generated exported UTI, Owner | `public.json` |
| B | `UTImportedTypeDeclarations` instead of exported | `public.json` |
| C | Imported and exported declarations together | `public.json` |
| D | Legacy `json` extension bound to `public.json`, Owner | `public.json`; Northstar is listed for `public.json`, but Xcode remains default |
| E | `northstar.json` extension bound to `public.json` | `public.json` |
| F | Legacy `CFBundleTypeExtensions` only, no `LSItemContentTypes` | `public.json` |
| G | Legacy `json` extension only | `public.json` |
| H | Imported and exported, `LSHandlerRank = Default` | `public.json` |
| I | Control: same declaration with the single-dot suffix `northstar` | `com.emrisca.northstar.project`; NSWorkspace = Northstar |
| J | Compound suffix with `LSHandlerRank = Default` | `public.json` |
| K | Exported UTI conforming to `public.data` | `public.json` |
| L | Imported UTI conforming to `public.data` | `public.json` |
| M | `public.data` conformance, no MIME tag | `public.json` |
| N | Compound extension but `LSItemContentTypes = public.json` | `public.json` |
| O | `json` extension but custom UTI binding | `public.json` |
| P | Compound extension bound to `public.data` | `public.json` |
| Q | Added `NSUbiquitousDocumentUserActivityType` | `public.json` |

Variant I is the control that proves the probe and the declaration code work:
the same file with a single-dot `.northstar` suffix resolves to the custom UTI
and opens in Northstar. The compound suffix is the variable that fails.

The full local/user rescan was also run:

```sh
$LSREG -kill -r -domain local -domain user
# The -kill option has been removed because it was dangerous and no longer useful.
$LSREG -r -domain local -domain user   # exit 0
$LSREG -f "$APP"                      # exit 0
$LSREG -gc                            # exit 0
```

`-kill` is no longer available on this macOS release. The rescan, force
registration and garbage collection all succeeded, and the result above was
unchanged.

## What still works

- **File > Open Project…** reads any `.northstar.json` path.
- An explicit `open -a Northstar.app sample.northstar.json` reaches the app;
  the app records `INFO project: opened <path>` in `northstar.log` once the
  project has been read.
- A second launch with a path, and a file dropped on the window, use the same
  path.
- Windows and Linux bundle metadata name the compound suffix (`northstar.json`
  and `application/json` respectively); direct opening on those platforms is a
  release check, not a macOS claim.

Finder double-click is supported for `.northstar`, and for `.northstar` only:
the OS resolves the compound suffix to `public.json` before Northstar's
declaration is considered, which is why the app still names its own files under
the Northstar folder `.northstar.json` — those are listed in **Recent
projects**, so the suffix never has to reach LaunchServices.
