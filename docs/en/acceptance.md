# On-a-real-machine acceptance checklist

**English** · [中文](../zh/acceptance.md)

This checklist lists **the parts of this branch (the app shell, the read-only panel, live refresh, caching, the i18n close-out) that can only be confirmed on a real machine.**

The reason it exists is simple: this branch was developed on macOS, and the panel (file tree / preview / Git) was verified against the fake backend in `src/lib/mock/`, while `cargo test` and `node --test` exercise pure logic. The items below **cannot be tested on a development machine at all**, so they are not a "todo list" — they are "someone has to do this once, on real hardware."

> **What the status labels mean**
>
> - **Not verified**: this branch had no way to run it. Do not count it as passing.
> - **Verified on the dev machine (mock)**: the logic and front-end behaviour were verified against the fake backend; what a real machine adds is "is it the same over a real SSH connection and a real filesystem?"

Confirm the baseline first:

```bash
ssh -o BatchMode=yes <Host> true     # succeeds with no interaction
cargo test -p faragent-service        # 76 tests
cargo test -p faragent-app            # 17 tests
cargo test -p faragent-helper         # 54 tests (30 lib + 2 main + 22 protocol)
cd apps/faragent-app && npm test      # 211 tests
```

---

## 1. Helper first upload, verification, reuse — Not verified

The install flow's three branches (upload / hit / reuse) are driven in unit tests by a fake `HelperHost`. What a real machine confirms is that **the same helper binary walks all three steps over a real SSH connection.**

**How to perform**

```bash
# Put the remote in a clean state
ssh <Host> 'rm -rf ~/.faragent'

# First time: no helper on the remote, so it should upload
faragent <Host>            # or open that host's panel in the desktop app

# Second time: same binary already there, so it should reuse it, no upload
ssh <Host> 'ls -l ~/.faragent/bin/faragent-helper'
faragent <Host>

# Force "same platform, different contents": corrupt the remote copy
ssh <Host> 'printf x >> ~/.faragent/bin/faragent-helper'
faragent <Host>            # hash mismatch → should re-upload and restore +x
```

**What to expect**

- First time: after the upload, `~/.faragent/bin/faragent-helper` exists, is executable, and runs (not `126`).
- Second time: no upload, and `HelperMode` reports native mode (`HelperMode::Native`, i.e. no script fallback).
- Third time: hash mismatch → re-upload; the verification passes again afterwards.

**What counts as failure**

- The second run uploads again (a few MB every time means the hash comparison is not working).
- The upload "succeeds" but the remote file is empty or not executable.
- The upload is declared done without any verification afterwards.

**How to tell it really reused**: the remote file's mtime is unchanged, meaning it was not rewritten.

---

## 2. A multi-MB binary over stdin — Not verified

The upload goes over an stdin channel (something like `ssh ... -- sh -c 'cat > ...'`), not a base64 argument. At multi-MB sizes, **argument limits, buffering and partial writes** are all in play.

**How to perform**

```bash
ls -l apps/faragent-app/src-tauri/resources/helper/*/faragent-helper   # the real size
ssh <Host> 'rm -rf ~/.faragent'
faragent <Host>
# Verify: the remote sha256 must match
shasum -a 256 apps/faragent-app/src-tauri/resources/helper/<platform>/faragent-helper
ssh <Host> 'sha256sum ~/.faragent/bin/faragent-helper || shasum -a 256 ~/.faragent/bin/faragent-helper'
```

**What to expect**: the two digests are byte-identical; the remote file size matches; `faragent-helper` then executes successfully.

**What counts as failure**: digests differ, the file is truncated, or it only fails occasionally on a slow link (which is worse — that is a race, so write it down).

---

## 3. A real `noexec` mount — Not verified

The `FallbackReason::NotExecutable` branch has only been unit-tested as "exit code 126 → judged not executable"; there is no real `noexec` filesystem involved.

**How to perform** (needs a Linux host with root / sudo)

```bash
sudo mkdir -p /tmp/noexec-home
sudo mount -t tmpfs -o noexec,size=64m tmpfs /tmp/noexec-home
# Either put the remote HOME on the noexec mount, or point the install dir at it
ssh -t <Host> 'HOME=/tmp/noexec-home faragent-helper --version'   # expect 126 / Permission denied
```

The 126 comes from the mount, not from the flag: `--version` prints and exits 0 on any writable mount (see §14), so a 126 here is the kernel refusing to exec the file at all.

**What to expect**: the panel / TUI says "the remote helper cannot be executed (exit 126): likely a noexec mount or a wrong architecture; using the script mode." — i.e. `HelperMode::ScriptFallback(FallbackReason::NotExecutable { .. })` — **and the session still works** (script mode is the fallback), rather than failing outright.

**What counts as failure**: it reports "file not found" or "upload failed" (the judgement landed on the wrong cause, so the user is sent to fix the wrong thing); or the connection just fails with no fallback offered.

---

## 4. An unwritable `$HOME` — Not verified

This is `FallbackReason::UploadFailed { detail }`. The unit test has a fake host that errors; there is no real permission problem.

**How to perform**

```bash
ssh <Host> 'rm -rf ~/.faragent && chmod a-w ~'          # read-only home
faragent <Host>
ssh <Host> 'chmod u+w ~'                                # restore
```

**What to expect**: the wording is "the helper upload failed ({detail}); using the script mode.", where `{detail}` should name the cause — home not writable / read-only; it falls back to script mode and the session still works.

**What counts as failure**: a raw shell error is dumped at the user (e.g. `Permission denied` plus a chunk of stderr); or nothing is shown at all.

---

## 5. A remote with neither `sha256sum` nor `shasum` — Not verified

`FallbackReason::NoChecksumTool`. The detection logic (`parse_probe`) has unit tests; what a real machine confirms is the behaviour on **a genuinely minimal image.**

**How to perform** (a minimal container is the easiest reproduction)

```bash
docker run --rm -it alpine:3.20 sh     # no coreutils sha256sum in there by default
# Point FarAgent at the sshd this container exposes, or use a minimal VM:
ssh <Host> 'command -v sha256sum || command -v shasum || echo NONE'
```

**What to expect**: the probe result shows no checksum tool, and the panel / TUI says "the remote (Linux) has neither sha256sum nor shasum, so the upload cannot be verified; falling back to script mode" — **and it does not attempt the upload** (it must not upload something it cannot verify).

**What counts as failure**: it uploads anyway; or the fallback message is about the wrong thing (e.g. blaming an unsupported platform).

---

## 6. A login-shell banner before the first frame — Not verified

The connection runs `bash -lc` (a login shell), so `/etc/motd`, conda, nvm and friends can leak into the protocol stream. The local mock has no banner.

**How to perform**

```bash
ssh <Host> 'echo "echo HELLO FROM MOTD" | sudo tee /etc/profile.d/faragent-banner.sh'
ssh -o BatchMode=yes <Host> true    # confirm a manual ssh shows the banner
faragent <Host>                     # then open the panel
```

**What to expect**: the banner text **never** appears in the panel's contents (not as file contents, not as a protocol frame), and the connection still succeeds.

**What counts as failure**: the banner shows up in a file preview; the protocol parser desynchronises into `not_found` / mojibake; or the connection fails.

---

## 7. Killing the connection reaps the remote child — Not verified

This is task 8's leak surface (the `ssh` child). On a dev machine only the front-end lease logic can be verified; **`pgrep` on the remote can only be done on a real machine.**

**How to perform**

```bash
# Connect and do enough that the helper is live
faragent <Host>
# Then "pull the plug": kill this side's ssh from another terminal
pkill -f 'ssh .*faragent-helper' || pkill -f 'ssh .*faragent'

# Immediately look for leftovers on the remote
ssh <Host> "pgrep -af 'faragent-helper'"
ssh <Host> "pgrep -af 'watch|inotifywait'"      # is there a watch child left over?
```

**What to expect**: no `faragent-helper` process remains on the remote; repeating (connect → pull the plug) several times does **not** accumulate processes.

**What counts as failure**: every pull leaves a process behind (a leak); or a watch child is left behind.

**Also verify the clean path**: close the panel / close the session from the UI, then `pgrep` the remote again — also empty.

---

## 8. Reclaiming connections and subscriptions (close panel / switch tab / switch host) — Verified on the dev machine (mock)

This is the branch's centrepiece. The **subscription count** can be counted against the mock (done), but **the remote side** can only be confirmed on a real machine.

**How to perform**

```bash
# Count subscriptions on the remote: did the helper actually unsubscribe?
ssh <Host> "ls /proc/\$(pgrep -f faragent-helper)/fd | wc -l"   # a rough look at fd growth
# More direct: the helper's own log (if any), or the inotify instance count
ssh <Host> "pgrep -af 'inotifywait|fswatch'"
```

In the UI, in order:

1. Open the panel → close the panel (**close panel**)
2. Open the panel → open a second session tab → switch back to the first (**switch tab**)
3. Open the panel → switch to another host and back (**switch host**)
4. Inside the panel click a file → make a change → cycle through the three Git tabs (**switch panel tabs**)

**What to expect**

- 1 / 2 / 3: each one releases the subscription — on the mock it was confirmed to emit one `watch.unsubscribe`, after which a further `fs.changed` for the old host reached **zero** subscribers (i.e. it really is gone on the remote side).
- 4: it does **not** release and does not re-subscribe — switching the panel's own tabs produces no `watch.subscribe` / `watch.unsubscribe` round trip (the watch is on the panel root, shared by all three tabs).
- Re-opening the panel drops the local query cache: switch immediately to a directory that does **not** exist on the remote and you should see a "not found" error, not the old directory's cached contents.

**What counts as failure**: three panel opens leave multiple subscriptions on the remote; every tab switch re-subscribes; the remote keeps pushing after the panel is closed.

---

## 9. The panel on a real repository (depth, large file, binary, big diff) — Partly verified on the dev machine (mock)

**Verified on the dev machine (mock)**

- **A file over the cap**: with the root at `/var/log/faragent`, opening `huge.log` (1.5 MiB, cap 1 MiB) shows "File is too large to preview" and does not pull the 1.5 MiB across.
- **A large diff**: with the root at `/srv/data`, the Git tab's `src/app.rs` row opened and the `git.diff` reply replaced with a 3001-line patch, the UI shows "Long diff, showing the first 2000 of 3001 lines" and renders only the first 2000 lines (nothing past line 1998 and not the last line is in the DOM); it holds in the English UI too. Screenshot: `.superpowers/sdd/dazzling-strolling-flurry/shots/diff-truncated-en-light.png` (that directory is gitignored and does not enter the repository).

**Not verified**: the 30-level tree, a real binary file (the fixture is `/srv/app/docs/img/logo.png`), and how the 620-change repository (`/srv/monorepo`) behaves in the UI.

The mock does have matching fixtures, so they can be driven on the dev machine before going to real hardware (see `HELPER_FIXTURES` in `src/lib/mock/helper.ts`):

| Shape | Mock fixture |
| --- | --- |
| A five-level-deep tree (with a symlink and a dot-directory) | `/srv/app` |
| 1.5 MiB of log lines | `/var/log/faragent/huge.log` |
| A file `fs.read` answers `binary` for | `/srv/app/docs/img/logo.png` |
| A repository with 14 changes, every status letter | `/srv/data` |
| A repository with **620** changes, over the helper's 500-entry cap | `/srv/monorepo` |
| A directory that is not a repository | `/srv/scratch` |

What a real machine adds is **scale** (30 levels, far more than 1.5 MiB, real link latency) and the behaviour of a **real filesystem**.

**How to perform**

```bash
# Deep tree
ssh <Host> 'mkdir -p /tmp/deep && cd /tmp/deep && for i in $(seq 1 30); do mkdir -p "d$i"; cd "d$i"; done && touch leaf.txt'
# Large file (> 1MB of text)
ssh <Host> 'head -c 3000000 /dev/urandom | base64 > /tmp/big.txt'
# Binary
ssh <Host> 'head -c 2000000 /dev/urandom > /tmp/blob.bin'
# More than 500 changed files
cd <repo> && for i in $(seq 1 600); do echo $i >> "gen/$i.txt"; done && git add -A
```

In the panel open `<repo>` (point the root at `/tmp/deep` and at the repository path), then in order:

- Expand down to the 30th level
- Preview `/tmp/big.txt`
- Preview `/tmp/blob.bin`
- Open the "Changes" tab and look at the 600 files

**What to expect**

- Deep tree: it expands all the way; expanding a parent does **not** re-fetch the whole tree (only that level spins).
- `> 1MB` text: truncation is stated clearly (a size/truncation notice), not silently showing only the first chunk; scrolling does not lock up.
- Binary: it says plainly "this is binary, its contents are not previewed" and does **not** paint mojibake on the screen.
- 600 files: the list remains usable (virtual scrolling or paging), not frozen; opening one file's diff requests only that file's patch.

**What counts as failure**: a preview shows half a file without saying it is truncated; binary is rendered as text; the UI freezes at 600 files; expanding one directory re-fetches the whole tree.

---

## 10. Push-driven refresh and burst coalescing (a real `git checkout` / `npm install`) — Verified on the dev machine (mock)

Verified against the mock: one `fs.changed` invalidates only the changed path's parent listing, the path's own listing, and its `stat` and `read` — never the whole `["panel"]`, so one `npm install` cannot re-walk the entire tree; 20 consecutive pushes coalesce into **1** round trip; `git.changed` refreshes only `status / branches / log / diff`, never `discover`.

What a real machine adds is **whether the pushes actually arrive and whether the volume holds up**:

```bash
# Burst one: npm install
ssh <Host> 'cd <repo> && npm install --no-audit --no-fund'

# Burst two: switch branches
ssh <Host> 'cd <repo> && git checkout <other-branch>'

# Burst three: a wide write
ssh <Host> 'cd <repo> && touch src/**/*.ts'
```

**What to expect**

- The tree / preview goes fresh by itself within a second, with no manual refresh.
- During the burst: the panel stays responsive and the SSH connection count does not explode (check `ss -tn | grep :22 | wc -l` on the remote; it should stay in the single digits).
- After `git checkout`, the Git tab's branch / commits / changes follow along.

**What counts as failure**: every file write sends a remote request (the remote's CPU is pinned by the panel); a push arrives but the UI does not update; the Git panel is still stale after `git checkout`.

---

## 11. The session-list poll pauses when the window is hidden or unfocused — Verified on the dev machine (mock)

The rule (`sessionPollInterval`) is unit-tested: hidden **or** unfocused returns `false`.

**How to perform**

```bash
# Watch the ssh connections (the session list uses another channel; the connection count to the host is enough)
lsof -i :22 | grep <Host> | wc -l
```

1. With the panel open and the window focused, wait 35 seconds → you should see one session-list refresh (roughly every 30 seconds).
2. Switch to another application (unfocused) or minimise (hidden), then wait 60 seconds → there should be **no new requests**.
3. Switch back → polling resumes at once (and it refreshes immediately on return).

**What counts as failure**: it keeps firing every 30 seconds while hidden / unfocused (an app left open overnight would send 2880 requests); switching back waits a full 30 seconds before refreshing.

---

## 12. The panel's copy, complete in both languages — Verified on the dev machine (mock + source scan)

`npm test` includes a scan: every key used in a component must exist in **both tables** in `lib/i18n.ts`; and every key in the tables must actually be used (no dead key). Six dead keys were removed (`panel.root`, `panel.scriptMode`, `panel.scriptModeHint`, `file.lines`, `changes.empty`, `changes.untracked`). **The timeout sentence** (the English-only string task 8 missed) is now in the table in both languages too.

What a real machine adds is **whether it renders without gaps or language mixing**:

1. Settings → switch the language to **English**, then read the panel's three tabs, the connection-failure page, the timeout notice, and the settings page (the disk-cache section) top to bottom.
2. Switch back to **中文** and read the same again.
3. Pay special attention to the connection-timeout sentence (trigger it by unplugging the network or pointing at a black-hole address).
4. Pay special attention to the disk-cache setting's sentence naming the directory.

**What to expect**: no blank labels, no `undefined`, no Chinese inside an English sentence (or the reverse) in either language; braces and number placeholders are all substituted (no leftover `{path}`).

**What counts as failure**: an unsubstituted `{path}`, `{size}` or `{op}`; two languages mixed in one sentence; a button whose text is empty in English.

---

## 13. The disk cache writes to the designated directory — Not verified (no backend command on this branch)

The directory the design designates is **`~/.faragent/app-cache/`**, and the settings page states that path honestly.

**But this branch implements no Tauri command that writes there**: `apps/faragent-app/src-tauri/` is outside this branch's scope, and the repository has no existing "write a file" command. So the current implementation puts the data in the **webview's own local storage (localStorage)**, under the key `faragent.appCache.bucket.v1`. The settings page spells this out ("this branch has no backend command to write to disk yet, so the data currently lives in the app's own local storage") — it does **not** pretend the data is already in `~/.faragent/`.

**How to perform**

```bash
# Open Settings → Disk cache → turn the switch on
ls -la ~/.faragent/app-cache/ 2>&1     # expected: does not exist — that is the unverified item above
```

**What to expect (current implementation)**: the switch starts **off**; after turning it on and browsing the panel, data appears in the webview's localStorage; turning the switch off, or clicking "Clear now", makes the data go away; "Clear now" does **not** turn the switch off.

**The next thing to verify (once the backend command exists)**

- The data really lands in `~/.faragent/app-cache/`, with predictable file names.
- Nothing new is written after the switch is turned off.
- **No credential ever touches disk**: `grep -ri 'password\|secret\|token\|id_rsa' ~/.faragent/app-cache/` should find nothing.
- The cached contents are **plain text**: directory listings, file contents, Git metadata. Open one of the files and confirm by eye that there is no binary mojibake (file contents are base64-encoded bytes, but the whole thing is text).

**What counts as failure**: a token, password or private key appears in the directory; it keeps writing after the switch is off; the clear button does not clear.

---

## 14. Artifacts CI builds but never runs — Not verified

The `helper` job in `.github/workflows/ci.yml` builds helper binaries for these platforms:

| Platform directory | Built by | Ever actually run? |
| --- | --- | --- |
| `linux-x86_64` | ubuntu job | Yes (`cargo test` locally runs the real binary, `the_real_built_helper_survives_the_local_round_trip`) |
| `linux-aarch64` | ubuntu job (musl + zig) | **No** — CI has no aarch64 Linux machine |
| `darwin-arm64` | macos job | Yes (macos-latest is arm64) |
| `darwin-x86_64` | macos job | **No** — the build machine is arm64, so `uname -m` takes the arm64 branch |
| `windows-x86_64` | windows job | **No** — that real-binary round-trip test is `#[cfg(unix)]`, so it does not even compile on Windows |

In other words: **the `linux-aarch64`, `darwin-x86_64` and `windows-x86_64` helpers "build, ship, and have never been run once on the hardware they target."**

**How to perform**

```bash
# On the matching machine (Raspberry Pi / ARM server / Intel Mac / Windows box)
uname -s -m                                    # Linux/aarch64, Darwin/x86_64
# Copy that platform's helper onto the machine, then:
~/.faragent/bin/faragent-helper --version      # or any read-only helper op
```

**What to expect**: the helper prints `faragent-helper <version>` and exits 0 — the same version its `ping` reply carries — with no architecture-mismatch error. (`--version` and `--help` are answered before stdin is ever read, so this line cannot hang.)

**What counts as failure**: `Exec format error`; a crash on startup; the musl static link missing symbols on the target distribution.

---

## 15. The Windows-remote environment wording — Not verified

Task 12 changed the wording of `FallbackReason::WindowsRemote`: it used to imply "falling back to script mode", but the helper channel is POSIX-only, so on Windows **no helper session can be opened at all**. It is now a plain failure statement, and it travels to the front end as a bilingual `localized` error (not a flattened English string), so a Chinese reader sees the Chinese half:

> the remote is Windows: the helper channel is POSIX-only, so no helper session can be opened on it.
> 远程是 Windows：helper 通道仅支持 POSIX，无法在这些远端打开 helper 会话。

The mock is aligned with that sentence (`win-builder` as a host name returns it), and `cargo test -p faragent-service` (76 tests) passes. What a real machine adds is **that on a real Windows OpenSSH host the user sees this, and not a script-fallback claim.**

**How to perform**

```bash
# On a Windows machine running OpenSSH Server
ssh <WinHost> 'cmd /c ver'          # confirm it is Windows
# Then pick that host in FarAgent
```

**What to expect**: a plain "Windows / the helper is POSIX-only / no session can be opened", not "falling back to script mode" — and in a Chinese UI, that sentence in Chinese.

**What counts as failure**: the wording claims "falling back to script mode" (which is untrue); the Chinese UI shows the English sentence; or a raw error the user cannot act on.

---

## 16. The script fallback's op shortfall is named, not silent — Verified on the dev machine (mock)

The bash fallback (`crates/faragent-remote/src/{fs,git}.rs`) speaks a seven-op vocabulary — `ping`, `fs.list`, `fs.read`, `fs.stat`, `git.discover`, `git.status`, `git.log`. It does **not** speak `git.diff`, `git.branches`, or `watch.subscribe`. Before this branch, the panel assumed all three: the Changes tab failed with `unknown op git.diff`, the branch list was unusable, and live refresh failed silently by design.

The mechanism that fixes this is already in the protocol and no longer unused: `ping`'s reply carries an `ops` list, and the panel pings once when its connection opens, then disables exactly the entries the remote cannot serve — each with a bilingual reason in place of the content, never a blank or a lie. Because the decision is per-op rather than "native vs. script", a *future* fallback that grows `git.diff` regains the feature without a code change.

**How to perform**

Force the fallback by any of the means in §3, §4, or by pointing the install dir at a mount without `sha256sum`/`shasum`; then open the panel on that host and walk the list below. On a dev machine the same walk is done against the mock's `gpu-box` host (`src/lib/mock/helper.ts` models it as `script_fallback`, and its `opCall` returns `unknown op` for anything outside the seven, exactly as the shell script does).

**What to expect** — item by item:

| Panel entry | On the fallback | Why |
| --- | --- | --- |
| Files tab: tree, preview, stat | **Works** | `fs.list`, `fs.read`, `fs.stat` are all in the vocabulary |
| Changes tab: the changed-file list | **Works** | `git.status` is |
| Changes tab: opening a file's diff | **Disabled** | no `git.diff`; the row is not expandable and says `changes.noDiffOp` |
| Git tab: repository / status / log | **Works** | `git.discover`, `git.status`, `git.log` are |
| Git tab: the branch list | **Disabled** | no `git.branches`; the section says `git.branchesUnsupported`, *not* "no branches" |
| Live refresh | **Off** | no `watch.subscribe`; a panel-level line says `panel.watchUnsupported` and no subscribe is sent |

Also confirm the **negative**: with the fallback forced, no request for `git.diff`, `git.branches`, or `watch.subscribe` is ever sent (wrap `window.__TAURI_INTERNALS__.invoke` and record the command names, as in the Appendix). And confirm the **positive**: on a native host (`build-01.farm.internal` in the mock) all six entries above behave as before — the capability gate must not disable anything the helper can serve.

**What counts as failure**: a disabled entry renders as an empty list or a spinner instead of the reason; the reason is English in a Chinese UI; any of the three unsupported ops is still sent; or a native host loses a feature it can serve.

---

## Appendix: reproducing pushes on a dev machine with the mock

Live refresh can be verified entirely without a real machine. A reviewer can use this:

```bash
# 1. Start the front end
npm --prefix apps/faragent-app run dev     # http://localhost:1420

# 2. Open the build-01.farm.internal panel, set its root to the repository
#    fixture /srv/data, then in the browser console (the handle only exists in dev mode)
__faragentMock.pokeWatch('build-01.farm.internal', '/srv/data/src/app.rs')
__faragentMock.pokeGitChanged('build-01.farm.internal')
```

- `pokeWatch` is delivered only to the subscriptions that **cover that path**, and returns how many heard it (a path outside the panel's root returns 0, so check the root first).
- Effect: the file tree refreshes the affected directory; the Git panel refreshes.
- To count whether extra SSH calls were made: wrap `window.__TAURI_INTERNALS__.invoke` and record the command names.
- The fixture names for each shape are in section 9's table (`/srv/monorepo` is the 620-change one).
