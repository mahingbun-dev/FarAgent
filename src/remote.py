#!/usr/bin/env python3
"""Remote helper for the farssh CLI. Runs on the SSH target."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

HOME = Path.home()
FARSSH_DIR = HOME / ".farssh"
TMUX_CONF = FARSSH_DIR / "tmux.conf"
REGISTRY = FARSSH_DIR / "registry.json"
TMUX_SOCKET = "farssh"

AGENTS = ("claude", "codex", "grok", "pi")

TMUX_CONF_BODY = """\
# Managed by farssh. Applies only to sessions started with -f this file.
set -g prefix C-g
unbind C-b
bind C-g send-prefix
bind g detach-client
bind d detach-client
set -g mouse on
set -g default-terminal "tmux-256color"
set -as terminal-features ",*:RGB"
set -g status-position top
set -g status-left-length 64
set -g status-left " #[bold]farssh#[default]  prefix C-g · C-g d detach "
set -g status-right " #{session_name} "
set -g history-limit 50000
set -g set-clipboard on
set -wg allow-passthrough on
set -g extended-keys on
set -g update-environment "TERM COLORTERM"
"""


def emit(obj: Any) -> None:
    json.dump(obj, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def which(name: str) -> str | None:
    return shutil.which(name)


def run_out(argv: list[str], timeout: int = 8) -> str:
    try:
        p = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return (p.stdout or "").strip() or (p.stderr or "").strip()


def version_of(bin_name: str) -> str:
    out = run_out([bin_name, "--version"])
    if not out and bin_name == "tmux":
        out = run_out([bin_name, "-V"])
    line = out.splitlines()[0] if out else ""
    return line[:160]


def auth_hint(agent: str) -> str:
    checks = {
        "grok": [HOME / ".grok" / "auth.json"],
        "claude": [
            HOME / ".claude.json",
            HOME / ".claude" / ".credentials.json",
            HOME / ".claude" / "credentials.json",
        ],
        "codex": [HOME / ".codex" / "auth.json", HOME / ".codex" / "config.toml"],
        "pi": [
            HOME / ".pi" / "agent" / "auth.json",
            HOME / ".pi" / "agent" / "settings.json",
        ],
    }
    for path in checks.get(agent, []):
        if path.exists() and path.stat().st_size > 0:
            return "ok"
    return "unknown"


def short_id(session_id: str) -> str:
    alnum = "".join(c for c in session_id if c.isalnum())
    if not alnum:
        return "new"
    return alnum[-12:]


def tmux_name(agent: str, session_id: str) -> str:
    return f"farssh-{agent}-{short_id(session_id)}"


def ensure_runtime() -> dict[str, Any]:
    FARSSH_DIR.mkdir(parents=True, exist_ok=True)
    TMUX_CONF.write_text(TMUX_CONF_BODY)
    if not REGISTRY.exists():
        REGISTRY.write_text("[]\n")
    return {"ok": True, "dir": str(FARSSH_DIR), "tmux_conf": str(TMUX_CONF)}


def load_registry() -> list[dict[str, Any]]:
    if not REGISTRY.exists():
        return []
    try:
        data = json.loads(REGISTRY.read_text() or "[]")
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def save_registry(rows: list[dict[str, Any]]) -> None:
    FARSSH_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps(rows, indent=2) + "\n")


def tmux_base() -> list[str]:
    return ["tmux", "-L", TMUX_SOCKET, "-f", str(TMUX_CONF)]


def tmux_sessions() -> set[str]:
    if not which("tmux"):
        return set()
    ensure_runtime()
    out = run_out(tmux_base() + ["list-sessions", "-F", "#{session_name}"], timeout=5)
    return {line.strip() for line in out.splitlines() if line.strip()}


def tmux_has(name: str) -> bool:
    if not which("tmux"):
        return False
    ensure_runtime()
    p = subprocess.run(
        tmux_base() + ["has-session", "-t", name],
        check=False,
        capture_output=True,
        timeout=5,
    )
    return p.returncode == 0


def probe() -> dict[str, Any]:
    tmux_path = which("tmux")
    agents = []
    for agent in AGENTS:
        path = which(agent)
        agents.append(
            {
                "id": agent,
                "found": bool(path),
                "path": path,
                "version": version_of(agent) if path else None,
                "auth_hint": auth_hint(agent) if path else "missing",
            }
        )
    return {
        "ok": True,
        "home": str(HOME),
        "user": os.environ.get("USER") or os.environ.get("LOGNAME") or "",
        "shell": os.environ.get("SHELL") or "",
        "path": os.environ.get("PATH") or "",
        "tmux": {
            "found": bool(tmux_path),
            "path": tmux_path,
            "version": version_of("tmux") if tmux_path else None,
        },
        "agents": agents,
    }


def read_jsonl_meta(path: Path, limit: int = 80) -> dict[str, Any]:
    title = None
    cwd = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= limit:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if cwd is None:
                    cwd = obj.get("cwd") or obj.get("cwd_path")
                    env = obj.get("environment_context") or ""
                    if not cwd and isinstance(env, str):
                        m = re.search(r"<cwd>([^<]+)</cwd>", env)
                        if m:
                            cwd = m.group(1)
                if title is None:
                    msg = obj.get("message") or obj.get("content")
                    text = None
                    if isinstance(msg, dict):
                        content = msg.get("content")
                        if isinstance(content, str):
                            text = content
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict) and part.get("type") == "text":
                                    text = part.get("text")
                                    break
                    elif isinstance(msg, str):
                        text = msg
                    if text:
                        text = text.strip().splitlines()[0][:80]
                        if text and not text.startswith("<"):
                            title = text
                if title and cwd:
                    break
    except OSError:
        pass
    return {"title": title, "cwd": cwd}


def grok_sessions() -> list[dict[str, Any]]:
    root = HOME / ".grok" / "sessions"
    active: dict[str, Any] = {}
    ap = HOME / ".grok" / "active_sessions.json"
    if ap.exists():
        try:
            rows = json.loads(ap.read_text() or "[]")
            if isinstance(rows, list):
                for row in rows:
                    sid = row.get("session_id")
                    if sid:
                        active[sid] = row
        except json.JSONDecodeError:
            pass
    out: list[dict[str, Any]] = []
    if not root.exists():
        return out
    for cwd_dir in root.iterdir():
        if not cwd_dir.is_dir():
            continue
        try:
            cwd = urllib.parse.unquote(cwd_dir.name)
        except Exception:
            cwd = cwd_dir.name
        for sid_dir in cwd_dir.iterdir():
            if not sid_dir.is_dir():
                continue
            sid = sid_dir.name
            summary: dict[str, Any] = {}
            sp = sid_dir / "summary.json"
            if sp.exists():
                try:
                    summary = json.loads(sp.read_text() or "{}")
                except json.JSONDecodeError:
                    summary = {}
            title = (
                summary.get("generated_title")
                or summary.get("session_summary")
                or summary.get("last_turn_summary")
                or sid
            )
            if isinstance(title, str):
                title = title.strip().splitlines()[0][:80]
            mtime = sid_dir.stat().st_mtime
            iso = summary.get("last_active_at") or summary.get("updated_at")
            out.append(
                {
                    "id": sid,
                    "agent": "grok",
                    "title": title,
                    "cwd": summary.get("git_root_dir") or cwd,
                    "mtime": mtime,
                    "mtime_iso": iso,
                    "live_agent": sid in active,
                    "tmux": tmux_name("grok", sid),
                }
            )
    return out


def claude_sessions() -> list[dict[str, Any]]:
    root = HOME / ".claude" / "projects"
    out: list[dict[str, Any]] = []
    if not root.exists():
        return out
    for proj in root.iterdir():
        if not proj.is_dir():
            continue
        slug = proj.name
        guessed = slug.replace("-", "/")
        if guessed.startswith("/") is False and guessed.startswith("Users"):
            guessed = "/" + guessed
        for jsonl in proj.glob("*.jsonl"):
            if ".orphaned-" in jsonl.name or ".superseded-" in jsonl.name:
                continue
            sid = jsonl.stem
            meta = read_jsonl_meta(jsonl)
            out.append(
                {
                    "id": sid,
                    "agent": "claude",
                    "title": meta.get("title") or sid,
                    "cwd": meta.get("cwd") or guessed,
                    "mtime": jsonl.stat().st_mtime,
                    "live_agent": False,
                    "tmux": tmux_name("claude", sid),
                }
            )
    return out


def codex_sessions() -> list[dict[str, Any]]:
    root = HOME / ".codex" / "sessions"
    out: list[dict[str, Any]] = []
    if not root.exists():
        return out
    uuid_re = re.compile(
        r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    )
    for jsonl in root.rglob("*.jsonl"):
        m = uuid_re.search(jsonl.name)
        sid = m.group(1) if m else jsonl.stem
        meta = read_jsonl_meta(jsonl, limit=120)
        out.append(
            {
                "id": sid,
                "agent": "codex",
                "title": meta.get("title") or sid,
                "cwd": meta.get("cwd"),
                "mtime": jsonl.stat().st_mtime,
                "live_agent": False,
                "tmux": tmux_name("codex", sid),
            }
        )
    return out


def pi_sessions() -> list[dict[str, Any]]:
    root = HOME / ".pi" / "agent" / "sessions"
    out: list[dict[str, Any]] = []
    if not root.exists():
        return out
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in {".jsonl", ".json"}:
            continue
        sid = path.stem
        meta = read_jsonl_meta(path) if path.suffix == ".jsonl" else {}
        cwd = meta.get("cwd")
        if not cwd:
            # Pi stores sessions under a cwd-derived directory.
            try:
                rel = path.relative_to(root)
                if len(rel.parts) >= 2:
                    cwd = urllib.parse.unquote(rel.parts[0])
            except ValueError:
                cwd = None
        out.append(
            {
                "id": sid,
                "agent": "pi",
                "title": meta.get("title") or sid,
                "cwd": cwd,
                "mtime": path.stat().st_mtime,
                "live_agent": False,
                "tmux": tmux_name("pi", sid),
            }
        )
    return out


def disk_sessions(agent: str) -> list[dict[str, Any]]:
    if agent == "grok":
        return grok_sessions()
    if agent == "claude":
        return claude_sessions()
    if agent == "codex":
        return codex_sessions()
    if agent == "pi":
        return pi_sessions()
    return []


def list_sessions(agent: str) -> dict[str, Any]:
    live_tmux = tmux_sessions()
    rows = disk_sessions(agent)
    seen_tmux = set()
    for row in rows:
        name = row.get("tmux")
        row["live"] = bool(name and name in live_tmux)
        if name:
            seen_tmux.add(name)
    # Live tmux sessions that are not yet on disk (brand-new).
    prefix = f"farssh-{agent}-"
    registry = {r.get("tmux"): r for r in load_registry() if r.get("agent") == agent}
    for name in sorted(live_tmux):
        if not name.startswith(prefix) or name in seen_tmux:
            continue
        info = registry.get(name) or {}
        rows.append(
            {
                "id": info.get("session_id") or name[len(prefix) :],
                "agent": agent,
                "title": info.get("title") or "(live)",
                "cwd": info.get("cwd"),
                "mtime": info.get("mtime") or 0,
                "live": True,
                "tmux": name,
            }
        )
        seen_tmux.add(name)
    rows.sort(key=lambda r: (not r.get("live"), -(r.get("mtime") or 0)))
    return {"ok": True, "sessions": rows}


def shell_join(argv: list[str]) -> str:
    return " ".join(shlex_quote(a) for a in argv)


def shlex_quote(s: str) -> str:
    if re.fullmatch(r"[\w@%+=:,./-]+", s):
        return s
    return "'" + s.replace("'", "'\"'\"'") + "'"


def agent_argv(agent: str, session_id: str | None) -> list[str]:
    if not session_id:
        return [agent]
    if agent == "claude":
        return ["claude", "--resume", session_id]
    if agent == "codex":
        return ["codex", "resume", session_id]
    if agent == "grok":
        return ["grok", "--resume", session_id]
    if agent == "pi":
        return ["pi", "--session", session_id]
    return [agent]


def start_session(agent: str, cwd: str, session_id: str | None, name: str) -> dict[str, Any]:
    ensure_runtime()
    if not which("tmux"):
        return {
            "ok": False,
            "error": "tmux_missing",
            "hint": "Install tmux on the remote host; farssh will not install it.",
        }
    if not which(agent):
        return {
            "ok": False,
            "error": "agent_missing",
            "hint": f"{agent} is not on PATH in a login shell.",
        }
    cwd_path = Path(cwd).expanduser()
    if not cwd_path.is_dir():
        return {"ok": False, "error": "cwd_missing", "hint": f"Not a directory: {cwd}"}
    if tmux_has(name):
        return {"ok": True, "action": "exists", "tmux": name, "cwd": str(cwd_path)}
    argv = agent_argv(agent, session_id)
    inner = f"exec {shell_join(argv)}"
    cmd = tmux_base() + [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        str(cwd_path),
        "--",
        "bash",
        "-lc",
        inner,
    ]
    p = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=15)
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "").strip()
        return {"ok": False, "error": "tmux_new_failed", "hint": err[:400]}
    rows = load_registry()
    rows = [r for r in rows if r.get("tmux") != name]
    rows.append(
        {
            "tmux": name,
            "agent": agent,
            "session_id": session_id,
            "cwd": str(cwd_path),
            "mtime": cwd_path.stat().st_mtime,
        }
    )
    save_registry(rows)
    return {"ok": True, "action": "created", "tmux": name, "cwd": str(cwd_path), "argv": argv}


def doctor() -> dict[str, Any]:
    info = probe()
    ensure = ensure_runtime() if info["tmux"]["found"] else {"ok": False, "hint": "tmux missing"}
    return {
        "ok": True,
        "probe": info,
        "runtime": ensure,
        "notes": [
            "Coding is the native agent TUI inside tmux socket 'farssh'.",
            "Detach with C-g d (prefix C-g). This does not kill the agent.",
            "Do not resume a live session; attach the existing tmux session.",
            "Grok clipboard over SSH: OSC 52, or grok wrap ssh if /doctor complains.",
        ],
        "tmux_conf": str(TMUX_CONF) if TMUX_CONF.exists() else None,
        "tmux_socket": TMUX_SOCKET,
        "mouse": "on (set in farssh tmux.conf)",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe")
    sub.add_parser("ensure")
    sub.add_parser("doctor")
    p_list = sub.add_parser("list")
    p_list.add_argument("--agent", required=True, choices=AGENTS)
    p_has = sub.add_parser("has")
    p_has.add_argument("--tmux", required=True)
    p_start = sub.add_parser("start")
    p_start.add_argument("--agent", required=True, choices=AGENTS)
    p_start.add_argument("--cwd", required=True)
    p_start.add_argument("--session-id")
    p_start.add_argument("--tmux", required=True)

    args = parser.parse_args()
    if args.cmd == "probe":
        emit(probe())
    elif args.cmd == "ensure":
        emit(ensure_runtime())
    elif args.cmd == "doctor":
        emit(doctor())
    elif args.cmd == "list":
        emit(list_sessions(args.agent))
    elif args.cmd == "has":
        emit({"ok": True, "live": tmux_has(args.tmux), "tmux": args.tmux})
    elif args.cmd == "start":
        emit(start_session(args.agent, args.cwd, args.session_id, args.tmux))
    else:
        emit({"ok": False, "error": "unknown_cmd"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
