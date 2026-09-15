#!/usr/bin/env bash
#
# Build the `faragent-helper` binary for every platform FarAgent ships it to,
# and drop each one into the Tauri resource tree so the desktop bundle carries
# it.
#
# Layout (pinned by the task brief — do not rename):
#
#   <remote `uname -s`> / <remote `uname -m`>   directory          target triple
#   Linux / x86_64                              linux-x86_64       x86_64-unknown-linux-musl
#   Linux / aarch64|arm64                       linux-aarch64      aarch64-unknown-linux-musl
#   Darwin / arm64                              darwin-arm64       aarch64-apple-darwin
#   Darwin / x86_64                             darwin-x86_64      x86_64-apple-darwin
#   Windows (any x86_64)                        windows-x86_64     x86_64-pc-windows-msvc
#
# Each directory holds one binary: `faragent-helper` (`faragent-helper.exe` on
# Windows). Output root: apps/faragent-app/src-tauri/resources/helper/.
#
# Design rules:
#   * Idempotent — deterministic output paths, safe to re-run.
#   * Usability first — a platform this machine cannot build is SKIPPED with a
#     printed reason, and the run still succeeds. Only a build that was
#     actually attempted and failed makes the script exit non-zero. A skip and
#     a failure are never silent, and never look alike.
#   * Linux is built with cargo-zigbuild against musl, statically linked: a
#     remote distro's glibc version is not ours to control, and a static
#     binary cannot fail on an old one.
#
# Usage:
#   scripts/build-helper.sh                     # every platform
#   scripts/build-helper.sh -p linux-x86_64     # one platform (repeatable)
#   scripts/build-helper.sh -p darwin-arm64 -p linux-x86_64
#   scripts/build-helper.sh --list
#   scripts/build-helper.sh --dry-run           # report what would happen
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_ROOT="$REPO_ROOT/apps/faragent-app/src-tauri/resources/helper"

ALL_PLATFORMS=(linux-x86_64 linux-aarch64 darwin-arm64 darwin-x86_64 windows-x86_64)

# --- platform tables ---------------------------------------------------------

# triple <platform>
triple_for() {
    case "$1" in
        linux-x86_64)   echo "x86_64-unknown-linux-musl" ;;
        linux-aarch64)  echo "aarch64-unknown-linux-musl" ;;
        darwin-arm64)   echo "aarch64-apple-darwin" ;;
        darwin-x86_64)  echo "x86_64-apple-darwin" ;;
        windows-x86_64) echo "x86_64-pc-windows-msvc" ;;
        *) return 1 ;;
    esac
}

# binary file name <platform>
bin_name_for() {
    case "$1" in
        windows-*) echo "faragent-helper.exe" ;;
        *)         echo "faragent-helper" ;;
    esac
}

# builder kind <platform>: zigbuild | native
kind_for() {
    case "$1" in
        linux-*) echo "zigbuild" ;;
        *)       echo "native" ;;
    esac
}

host_os() {
    case "$(uname -s)" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *) echo "unknown" ;;
    esac
}

usage() {
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# --- argument parsing --------------------------------------------------------

SELECTED=()
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        -p|--platform)
            [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }
            SELECTED+=("$2")
            shift 2
            ;;
        --platform=*)
            SELECTED+=("${1#*=}")
            shift
            ;;
        --list)
            for p in "${ALL_PLATFORMS[@]}"; do printf '%-16s %s\n' "$p" "$(triple_for "$p")"; done
            exit 0
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [ "${#SELECTED[@]}" -eq 0 ]; then
    SELECTED=("${ALL_PLATFORMS[@]}")
fi

for p in "${SELECTED[@]}"; do
    if ! triple_for "$p" >/dev/null; then
        echo "error: unknown platform '$p' (try --list)" >&2
        exit 2
    fi
done

# --- toolchain probes --------------------------------------------------------

HOST="$(host_os)"

have() { command -v "$1" >/dev/null 2>&1; }

target_installed() {
    have rustup || return 1
    rustup target list --installed 2>/dev/null | grep -qx "$1"
}

have_zigbuild() { have cargo-zigbuild; }
have_zig() { have zig; }

# --- results bookkeeping -----------------------------------------------------

PRODUCED=()
SKIPPED=()
FAILED=()

say()  { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# --- one platform ------------------------------------------------------------

build_platform() {
    local platform="$1"
    local triple; triple="$(triple_for "$platform")"
    local kind;   kind="$(kind_for "$platform")"
    local bin;    bin="$(bin_name_for "$platform")"
    local dest_dir="$OUT_ROOT/$platform"
    local dest="$dest_dir/$bin"

    say "==> $platform  ($triple)"

    # --- preconditions (a miss here is a SKIP, never a failure) ---
    if [ "$kind" = "zigbuild" ]; then
        if ! have_zigbuild; then
            SKIPPED+=("$platform: cargo-zigbuild not installed")
            note "SKIP: cargo-zigbuild not installed (cargo install cargo-zigbuild)"
            return 0
        fi
        if ! have_zig; then
            SKIPPED+=("$platform: zig not installed")
            note "SKIP: zig not installed (cargo-zigbuild needs it to link musl)"
            return 0
        fi
    fi

    case "$platform" in
        darwin-*)
            if [ "$HOST" != "macos" ]; then
                SKIPPED+=("$platform: needs a macOS host (this is $HOST)")
                note "SKIP: Apple targets only build on macOS (host is $HOST)"
                return 0
            fi
            ;;
        windows-*)
            if [ "$HOST" != "windows" ]; then
                SKIPPED+=("$platform: needs a Windows host (this is $HOST)")
                note "SKIP: MSVC targets only build on a Windows host (host is $HOST); let CI produce it"
                return 0
            fi
            ;;
    esac

    if ! target_installed "$triple"; then
        SKIPPED+=("$platform: rustup target $triple not installed")
        note "SKIP: rustup target $triple not installed (rustup target add $triple)"
        return 0
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
        SKIPPED+=("$platform: dry-run")
        note "DRY-RUN: would build -> $dest"
        return 0
    fi

    # --- the build itself (a failure here IS a failure) ---
    local -a cmd
    case "$kind" in
        zigbuild) cmd=(cargo zigbuild --release --package faragent-helper --target "$triple") ;;
        *)        cmd=(cargo build    --release --package faragent-helper --target "$triple") ;;
    esac

    note "build: ${cmd[*]}"
    if ! ( cd "$REPO_ROOT" && "${cmd[@]}" ); then
        FAILED+=("$platform: build command failed")
        note "FAIL: ${cmd[*]}"
        return 1
    fi

    local built="$REPO_ROOT/target/$triple/release/$bin"
    if [ ! -f "$built" ]; then
        FAILED+=("$platform: expected artifact missing at $built")
        note "FAIL: no artifact at $built after a successful build"
        return 1
    fi

    mkdir -p "$dest_dir"
    # Copy to a temp name then rename: a reader (or a re-run) never sees a
    # half-written binary at the deterministic path.
    if ! cp -f "$built" "$dest.tmp" || ! mv -f "$dest.tmp" "$dest"; then
        rm -f "$dest.tmp"
        FAILED+=("$platform: could not write $dest")
        note "FAIL: could not write $dest"
        return 1
    fi
    chmod +x "$dest" 2>/dev/null || true

    local size; size="$(wc -c < "$dest" | tr -d ' ')"
    PRODUCED+=("$platform  $triple  ${size} bytes")
    note "OK: $dest (${size} bytes)"
    return 0
}

# --- run ---------------------------------------------------------------------

say "faragent-helper build"
say "  repo:   $REPO_ROOT"
say "  output: $OUT_ROOT"
say "  host:   $HOST ($(uname -m))"
[ "$DRY_RUN" -eq 1 ] && say "  mode:   DRY RUN (nothing will be built)"
say ""

for platform in "${SELECTED[@]}"; do
    build_platform "$platform" || true
done

# --- summary -----------------------------------------------------------------

say ""
say "----------------------------------------"
say "SUMMARY"
say "----------------------------------------"
say "produced (${#PRODUCED[@]}):"
if [ "${#PRODUCED[@]}" -eq 0 ]; then
    note "(none)"
else
    for line in "${PRODUCED[@]}"; do note "$line"; done
fi
say "skipped (${#SKIPPED[@]}):"
if [ "${#SKIPPED[@]}" -eq 0 ]; then
    note "(none)"
else
    for line in "${SKIPPED[@]}"; do note "$line"; done
fi
say "failed (${#FAILED[@]}):"
if [ "${#FAILED[@]}" -eq 0 ]; then
    note "(none)"
else
    for line in "${FAILED[@]}"; do note "$line"; done
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
    exit 1
fi

if [ "${#PRODUCED[@]}" -eq 0 ]; then
    say ""
    say "nothing was produced; every requested platform was skipped (see reasons above)"
fi
exit 0
