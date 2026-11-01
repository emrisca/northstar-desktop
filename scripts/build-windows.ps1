# Build Northstar for Windows from a normal PowerShell prompt.
#
# The shell is Rust plus a WebView2 host, so Windows needs the MSVC Rust host,
# the Visual Studio C++ tools and the Windows SDK. This checks those, installs
# the pinned npm packages, runs the full frontend and Rust test command, and
# leaves the release executable and installer artifacts in
# src-tauri\target\release.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipTests

#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail([string]$message) {
    Write-Host "error: $message" -ForegroundColor Red
    exit 1
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Fail 'Node.js was not found. Install Node 20 or newer from https://nodejs.org/ and open a new terminal.'
}
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    Fail "Node $nodeVersion is too old; Northstar needs Node 20 or newer."
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
    Fail 'npm was not found beside Node. Reinstall Node 20 or newer.'
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -or -not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    Fail 'The Rust toolchain was not found. Install it from https://rustup.rs/ with the MSVC default host, then open a new terminal.'
}
$rustHost = (& rustc -vV | Select-String '^host:').ToString().Trim()
if ($rustHost -notmatch 'windows-msvc') {
    Fail "Rust is targeting '$rustHost'. Install the MSVC toolchain with: rustup default stable-msvc"
}

# The MSVC linker can be present without being on PATH when the machine has the
# Visual Studio C++ workload; vswhere is the reliable check, and rustc uses the
# same installation when it links.
$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
$hasVcTools = $false
if (Test-Path $vswhere) {
    $install = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $hasVcTools = [bool]$install
}
if (-not $hasVcTools) {
    Fail "The MSVC C++ tools were not found. Install Visual Studio Build Tools 2022 and tick 'Desktop development with C++' (MSVC and the Windows SDK)."
}

if (-not (Test-Path 'src-tauri\resources\rtklib\windows\bin\rnx2rtkp.exe')) {
    Write-Warning 'The Windows RTKLIB bundle is missing; conversion and correction will need the recovery installer.'
}

Write-Host "Node $nodeVersion; $rustHost"
Write-Host 'Installing the pinned npm packages...'
& $npm.Source ci
if ($LASTEXITCODE -ne 0) {
    Fail "npm ci failed with exit code $LASTEXITCODE."
}

if (-not $SkipTests) {
    Write-Host 'Running the frontend and Rust tests...'
    & $npm.Source test
    if ($LASTEXITCODE -ne 0) {
        Fail "npm test failed with exit code $LASTEXITCODE."
    }
}

Write-Host 'Building the release executable and installer...'
& $npm.Source run build
if ($LASTEXITCODE -ne 0) {
    Fail "npm run build failed with exit code $LASTEXITCODE."
}

& $npm.Source run verify:package
if ($LASTEXITCODE -ne 0) {
    Fail "npm run verify:package failed with exit code $LASTEXITCODE."
}

$exe = Join-Path $root 'src-tauri\target\release\northstar.exe'
if (-not (Test-Path $exe)) {
    Fail "The build finished but $exe is missing."
}
$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ''
Write-Host "Built $exe ($size MB)" -ForegroundColor Green
Write-Host 'Run it from Explorer, or run npm run dev for the hot-reload loop.'
