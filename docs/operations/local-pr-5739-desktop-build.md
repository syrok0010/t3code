# Local T3 Code build runbook

This file documents the local patch and repeatable desktop build workflow for
`/home/syrok/projects/t3code` on `syrok-server`.

## What the local patch does

The upstream feature is PR [#5739](https://github.com/pingdotgg/t3code/pull/5739),
which shows Claude and Codex subscription limits on the Usage page and in the
sidebar Usage hover card.

The local commit on branch `local/pr-5739-multi-instance` extends that feature
for multiple configured accounts:

- account-limit snapshots are keyed by `providerInstanceId`, not only by
  provider kind;
- live runtime events keep their provider-instance identity;
- Codex transcript fallback scans every configured Codex home;
- the web client keeps each environment/instance pair and labels it with the
  provider instance display name;
- the Usage page and hover card render one set of meters per instance.

### Shared CODEX_HOME and shadow accounts

Several Codex instances may use one shared `homePath` and separate
`shadowHomePath` values. Their `sessions` directory is shared, and Codex
transcript rate-limit records do not identify the account that produced them.
The local patch therefore does not use transcript fallback for any group of
instances resolving to the same sessions directory; copying the newest shared
record would incorrectly show identical usage for every account.

On first start after this fix, cached transcript-derived copies for such a
group are removed automatically. The normal per-instance provider health probe
starts each configured Codex app-server briefly and requests
`account/rateLimits/read`, so every authenticated shadow account fills its own
meter without requiring a chat session. The web client refreshes the limits
query when those probes publish their results. Live snapshots remain separate
by instance and are persisted across restarts. Instances with genuinely
separate `homePath` directories still recover independently from their own
transcripts.

Keep this change as one local commit so it can be cherry-picked onto a refreshed
PR or onto `main` after the upstream PR merges.

## Refresh the source while preserving the local patch

Before resetting the build branch, make sure the durable local ref exists:

```bash
cd /home/syrok/projects/t3code
git show --stat local/pr-5739-multi-instance
```

While PR #5739 is open:

```bash
git fetch origin main
git fetch origin '+pull/5739/head:refs/heads/pr-5739-latest'
git checkout -B pr-5739-build pr-5739-latest
git rebase origin/main
git cherry-pick local/pr-5739-multi-instance
git branch -f local/pr-5739-multi-instance HEAD
```

After PR #5739 merges, use `origin/main` directly:

```bash
git fetch origin main
git checkout -B pr-5739-build origin/main
git cherry-pick local/pr-5739-multi-instance
git branch -f local/pr-5739-multi-instance HEAD
```

If cherry-pick reports that the change is already upstream, inspect the diff and
skip the cherry-pick only when multi-instance limit snapshots and UI labels are
actually present in `main`.

Confirm the intended ancestry before building:

```bash
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
git log --oneline --decorate -12
```

## Machine-specific constraints

- Use the HTTP proxy at `http://127.0.0.1:1080` for dependency and Electron
  downloads.
- Build Windows and Linux sequentially. Parallel electron-builder/7za processes
  can exhaust memory and freeze the server.
- Set `ELECTRON_BUILDER_COMPRESSION_LEVEL=1`; do not add `nice`.
- System Rust is currently 1.85, while `sysinfo@0.39.3` requires Rust 1.95.
  Do not downgrade dependencies or rewrite the lockfile to work around this.
- `scripts/build-desktop-artifact.ts` always invokes Cargo for the native
  resource monitor. A Cargo no-op shim is safe only after verified real PE/ELF
  monitor binaries have been placed in their expected target directories.
- Linux icon resizing expects ImageMagick. This host uses a temporary `magick`
  wrapper around `/usr/bin/ffmpeg` for the one supported resize call.

## Prepare dependencies and native monitor binaries

```bash
cd /home/syrok/projects/t3code
env \
  HTTP_PROXY=http://127.0.0.1:1080 \
  HTTPS_PROXY=http://127.0.0.1:1080 \
  http_proxy=http://127.0.0.1:1080 \
  https_proxy=http://127.0.0.1:1080 \
  pnpm install --frozen-lockfile
```

Expected native paths:

```text
native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe
native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor
```

Before reusing the existing binaries, verify that the native source has not
changed since the successful CI artifact they came from:

```bash
git diff --name-status \
  e6987965f65914861f0dabd0db03729fe5cd2508..origin/main \
  -- native/resource-monitor
file \
  native/resource-monitor/target/x86_64-pc-windows-msvc/release/t3-resource-monitor.exe \
  native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor
```

The diff must be empty, and `file` must report a Windows PE32+ executable and a
Linux x86-64 ELF executable. If the source changed, download matching
`resource-monitor-win32-x64` and `resource-monitor-linux-x64` artifacts from a
successful `release.yml` run for the new source revision before proceeding.

Create temporary shims:

```bash
mkdir -p /tmp/t3code-cargo-shim-pr5739 /tmp/t3code-imagemagick-shim-pr5739

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "${1:-}" == "build" ]] || exit 2' \
  'exit 0' \
  > /tmp/t3code-cargo-shim-pr5739/cargo

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "$#" -eq 4 && "$2" == "-resize" ]] || exit 2' \
  'dimensions="${3/x/:}"' \
  'exec /usr/bin/ffmpeg -hide_banner -loglevel error -y -i "$1" -vf "scale=${dimensions}" "$4"' \
  > /tmp/t3code-imagemagick-shim-pr5739/magick

chmod +x \
  /tmp/t3code-cargo-shim-pr5739/cargo \
  /tmp/t3code-imagemagick-shim-pr5739/magick
```

## Choose a new artifact directory

Every rebuild gets a revision-and-time-specific directory, so even two builds
of the same package version cannot overwrite one another:

```bash
export T3_BUILD_REVISION="$(git rev-parse --short=12 HEAD)"
export T3_BUILD_STAMP="$(date +%Y%m%d-%H%M%S)"
export T3_BUILD_ROOT="release/pr-5739-multi-instance/${T3_BUILD_STAMP}-${T3_BUILD_REVISION}"
mkdir -p "$T3_BUILD_ROOT/windows" "$T3_BUILD_ROOT/linux"
```

Keep these exports in the shell used for both builds and verification.

## Build Windows and Linux ZIPs

Windows first:

```bash
env \
  PATH=/tmp/t3code-cargo-shim-pr5739:$PATH \
  HTTP_PROXY=http://127.0.0.1:1080 \
  HTTPS_PROXY=http://127.0.0.1:1080 \
  http_proxy=http://127.0.0.1:1080 \
  https_proxy=http://127.0.0.1:1080 \
  ELECTRON_BUILDER_COMPRESSION_LEVEL=1 \
  pnpm node scripts/build-desktop-artifact.ts \
    --platform win --target zip --arch x64 \
    --output-dir "$T3_BUILD_ROOT/windows"
```

After it exits successfully, build Linux:

```bash
env \
  PATH=/tmp/t3code-cargo-shim-pr5739:/tmp/t3code-imagemagick-shim-pr5739:$PATH \
  HTTP_PROXY=http://127.0.0.1:1080 \
  HTTPS_PROXY=http://127.0.0.1:1080 \
  http_proxy=http://127.0.0.1:1080 \
  https_proxy=http://127.0.0.1:1080 \
  ELECTRON_BUILDER_COMPRESSION_LEVEL=1 \
  pnpm node scripts/build-desktop-artifact.ts \
    --platform linux --target zip --arch x64 \
    --output-dir "$T3_BUILD_ROOT/linux"
```

The Windows warning about a missing WSL `node-pty` prebuild is known: native
Windows terminals work, but the packaged WSL backend does not start unless a
Linux `pty.node` is supplied separately.

## Deploy a verified Windows ZIP to syrok's Desktop

The build host can deploy the Windows ZIP over the WireGuard network when the
Windows machine is online. The target is `syrok@10.9.0.5`; SSH public-key
authentication is already configured from this host. Do this only after the
Windows archive has passed the verification below.

First, require both SSH access and the expected Desktop path:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=8 syrok@10.9.0.5 \
  powershell.exe -NoProfile -NonInteractive -Command \
  "[Environment]::GetFolderPath('Desktop')"
```

It must print `C:\Users\syrok\Desktop`. If the command fails, leave the
artifact on the build host and report that the Windows machine is unavailable.

For a verified archive, set its path and copy it to a unique temporary name in
the remote user's home directory:

```bash
export T3_WINDOWS_ARCHIVE="$T3_BUILD_ROOT/windows/T3-Code-<version>-x64.zip"
export T3_WINDOWS_ARCHIVE_NAME="$(basename "$T3_WINDOWS_ARCHIVE")"
export T3_WINDOWS_STAGE="t3code-deploy-${T3_BUILD_STAMP}-${T3_WINDOWS_ARCHIVE_NAME}"
export T3_WINDOWS_DATE="$(TZ=Europe/Moscow date +%d.%m)"

scp "$T3_WINDOWS_ARCHIVE" "syrok@10.9.0.5:$T3_WINDOWS_STAGE"
```

Then create the Desktop directory and unpack. The archive filename determines
the base directory, for example `T3-Code-0.0.33-x64`. If it already exists,
the deployment uses `_12.08`; if that also exists, it uses `_12.08_2`, then
increments the final number. Existing directories are never replaced.

```bash
ssh -T -o BatchMode=yes -o ConnectTimeout=8 syrok@10.9.0.5 \
  powershell.exe -NoProfile -NonInteractive -Command - <<POWERSHELL
\$ErrorActionPreference = 'Stop'
\$archive = Join-Path \$HOME '$T3_WINDOWS_STAGE'
\$desktop = [Environment]::GetFolderPath('Desktop')
\$baseName = [System.IO.Path]::GetFileNameWithoutExtension(\$archive)
\$target = Join-Path \$desktop \$baseName

if (Test-Path -LiteralPath \$target) {
  \$datedBase = '{0}_{1}' -f \$baseName, '$T3_WINDOWS_DATE'
  \$target = Join-Path \$desktop \$datedBase
  \$index = 2
  while (Test-Path -LiteralPath \$target) {
    \$target = Join-Path \$desktop ('{0}_{1}_{2}' -f \$baseName, '$T3_WINDOWS_DATE', \$index)
    \$index++
  }
}

New-Item -ItemType Directory -Path \$target -ErrorAction Stop | Out-Null
Expand-Archive -LiteralPath \$archive -DestinationPath \$target -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path \$target 'T3 Code (Alpha).exe'))) {
  throw "Deployment failed: T3 Code executable is missing from \$target"
}
Remove-Item -LiteralPath \$archive -Force
Write-Output "DEPLOYED_TO=\$target"
POWERSHELL
```

Completion requires the `DEPLOYED_TO=` line and the full path to a Desktop
directory. Keep the local ZIP; the remote temporary ZIP is removed only after
the executable is present.

## Verify and clean up

Use the actual version printed by the build in place of `<version>`:

```bash
unzip -t "$T3_BUILD_ROOT/windows/T3-Code-<version>-x64.zip"
unzip -t "$T3_BUILD_ROOT/linux/T3-Code-<version>-x64.zip"
sha256sum \
  "$T3_BUILD_ROOT/windows/T3-Code-<version>-x64.zip" \
  "$T3_BUILD_ROOT/linux/T3-Code-<version>-x64.zip"

unzip -Z1 "$T3_BUILD_ROOT/windows/T3-Code-<version>-x64.zip" \
  | rg 'T3 Code \(Alpha\)\.exe$|resources/app\.asar$'
unzip -Z1 "$T3_BUILD_ROOT/linux/T3-Code-<version>-x64.zip" \
  | rg 't3code$|resources/app\.asar$'
```

Remove only the two temporary shim directories after both builds finish:

```bash
rm /tmp/t3code-cargo-shim-pr5739/cargo
rm /tmp/t3code-imagemagick-shim-pr5739/magick
rmdir /tmp/t3code-cargo-shim-pr5739 /tmp/t3code-imagemagick-shim-pr5739
```

Do not overwrite `release/pr-4326`, `release/pr-1732`, `release/pr-5739`,
`release/main`, or earlier timestamped directories under
`release/pr-5739-multi-instance`; they are retained for comparison.
