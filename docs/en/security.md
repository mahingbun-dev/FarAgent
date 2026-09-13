# Security

**English** · [中文](../zh/security.md)

`faragent` is an SSH client wrapper. Anyone who can use it against a host can run that user’s coding agents and therefore read and write their repos. Do not expose home `sshd` to the public internet unless you must; reaching a NAT’d machine is covered in [SSH access · Tailscale](ssh-access.md#tailscale-for-nat-traversal-recommended).

## What we assume

- You already trust `ssh <host>` as that user.
- Authentication defaults to **keys / ssh-agent** (`BatchMode`); SSH itself does not prompt. When a server only accepts an account password you can switch that host to password mode: the password goes **only into system OpenSSH** — FarAgent never reads it, forwards it, or writes it to config or logs. What is left behind is a multiplexed ControlMaster socket (`~/.faragent/cm/`, mode `0700`, kept 4 hours by default). `faragent auth --host X --mode key` goes back to keys-only at any time.
- Remote commands (`bash -lc`, tmux socket `faragent`) run as the SSH user. Confirmed tmux/curl steps may call `sudo` in a live PTY (you type that password there; FarAgent does not store it).

## What we do not do

- Copy API keys, `auth.json`, or cookies to the laptop
- Listen on `0.0.0.0` or publish a gateway
- Copy unofficial install scripts from the remote (installer URLs are hardcoded)
- Run `sudo` except for tmux/curl via brew/apt/dnf/yum/pacman/apk after an on-screen confirm
- Delete agent config/keys (`~/.claude`, `~/.codex`, `~/.grok`, `~/.pi`) on uninstall
- Bypass macOS TCC; if `sshd` cannot read `Documents`, grant Full Disk Access to it yourself

## Report a vulnerability

Open a private GitHub security advisory on this repository, or contact the maintainer listed on the GitHub profile. Please do not file a public issue for credential leaks or RCE in the remote helper until a fix exists.
