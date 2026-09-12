# Security

**English** · [中文](SECURITY.zh-CN.md)

`everywhere` is an SSH client wrapper. Anyone who can use it against a host can run that user’s coding agents and therefore read and write their repos.

## What we assume

- You already trust `ssh <host>` as that user.
- Authentication is **keys / ssh-agent only** (`BatchMode`). The tool will not prompt for a password.
- The remote helper (`~/.everywhere/remote.py`, tmux socket `everywhere`) runs as the SSH user, not root.

## What we do not do

- Copy API keys, `auth.json`, or cookies to the laptop
- Listen on `0.0.0.0` or publish a gateway
- Install packages on the remote
- Bypass macOS TCC; if `sshd` cannot read `Documents`, grant Full Disk Access to it yourself

## Report a vulnerability

Open a private GitHub security advisory on this repository, or contact the maintainer listed on the GitHub profile. Please do not file a public issue for credential leaks or RCE in the remote helper until a fix exists.
