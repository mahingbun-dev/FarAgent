# SSH access: LAN, public IP, domain, Tailscale

**English** · [中文](../zh/ssh-access.md)

FarAgent does **not** punch NAT for you. It reads concrete `Host` entries from `~/.ssh/config` and runs system OpenSSH.

Authentication defaults to **keys / ssh-agent** (`BatchMode`, no password prompt). If the server only allows an account password, FarAgent **tells you on the error screen** and lets you do one interactive login (the password goes straight to OpenSSH), then reuses that connection — see [password-only servers](#password-only-servers-optional).

This chapter has one job: make `ssh <Host> true` work on the network you actually use. After that, pick the same Host in the TUI. When it fails, FarAgent shows the **raw ssh output plus the cause and copy-pasteable fixes**; the table is [when it fails](#when-it-fails-error-cause-fix).

Four usual ways in:

| Where you are | Use | Router changes? |
| --- | --- | --- |
| Same Wi-Fi / same office LAN | [LAN IP](#lan) | No |
| Cloud VM, or home WAN with a real public IPv4/IPv6 | [Public IP](#public-ip) | Home WAN usually needs port forward |
| Public IP changes, or you want a name | [Domain](#domain) | Home WAN still needs a forward |
| Home box behind NAT / CGNAT, or you need a café / LTE path | [Tailscale (recommended)](#tailscale-for-nat-traversal-recommended) | **No** |

Jump hosts / `ProxyJump` are handled by system ssh, not by FarAgent: the test is still whether `ssh <Host> true` works. A tunnel that looks like a direct address (for example `HostName 127.0.0.1` plus a local forwarded port) can work too; Tailscale is less work on a home connection.

OTP / two-factor: when the server offers it through **keyboard-interactive**, type the code at the prompt during the interactive login in password mode.

---

## What FarAgent requires

The picker lists **non-pattern** `Host` names only. `Host *` and `Host *.github.com` are skipped.

`HostName` may be any of these — FarAgent does not care which:

- LAN address: `192.168.1.8`, `10.0.0.4`
- Public IPv4 / IPv6
- DNS name: `gpu.example.com`, `home.example.com`
- Tailscale: `100.x.y.z`, or a MagicDNS name

Before opening the TUI:

```bash
ssh -o BatchMode=yes home-mac true    # the key path must work with zero prompts
faragent doctor --host home-mac
```

If `BatchMode=yes` works, you are done.

If it fails, first find out what the server wants:

```bash
# Ask which auth methods it accepts (this never logs in)
ssh -o PreferredAuthentications=none home-mac true
# -> Permission denied (publickey).              keys only
# -> Permission denied (publickey,password).     passwords allowed too
```

Three modes, switchable at any time (press **`g`** in the TUI host list to cycle):

```bash
faragent auth --host home-mac                 # show the current mode
faragent auth --host home-mac --mode auto     # default: try keys, offer a prompt if the server wants a password
faragent auth --host home-mac --mode key      # key only, never prompts
faragent auth --host home-mac --mode password # account password / keyboard-interactive
```

---

## Shared setup: sshd and keys

Do this once, then pick LAN / public IP / domain / Tailscale.

### 1. Enable SSH on the remote

**macOS remote**

System Settings → General → Sharing → **Remote Login**. Or:

```bash
sudo systemsetup -setremotelogin on
```

**Linux remote**

```bash
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y openssh-server
sudo systemctl enable --now ssh

# Fedora / RHEL
sudo dnf install -y openssh-server
sudo systemctl enable --now sshd

# Arch
sudo pacman -S --noconfirm openssh
sudo systemctl enable --now sshd
```

#### Windows remote (native)

On Windows 11, install the OpenSSH **Server** (an admin PowerShell):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
```

Keep the default shell (cmd.exe) — faragent detects the OS and talks to PowerShell by itself, no remote configuration needed. If the `DefaultShell` registry value was changed and things broke, set it back:

```powershell
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
  -Value 'C:\Windows\System32\cmd.exe' -PropertyType String -Force
Restart-Service sshd
```

Keys go to `%USERPROFILE%\.ssh\authorized_keys` (the OpenSSH Server optional feature sets up the right ACLs; for an administrator account there is a second `administrators_authorized_keys` file). WSL2 also still works — it is just a Linux host.

Check it is running:

```bash
# Linux
sudo systemctl status ssh    # or sshd

# on the remote itself
ssh -o BatchMode=yes localhost true
```

### 2. Allow TCP 22 on the firewall that should see it

- **LAN / Tailscale:** allow SSH on the host firewall. Port 22 on the Tailscale interface does **not** need to be open to the public internet.
- **Public IP / domain:** also open it on the cloud security group or home router (see below). That is riskier.

Linux examples:

```bash
# ufw
sudo ufw allow OpenSSH
sudo ufw enable

# firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
```

macOS Remote Login usually opens the macOS firewall for you.

### 3. Create a key on the laptop and install it on the remote

This is the recommended path: keys are stable, individually revocable, and survive password rotations.

```bash
ssh-keygen -t ed25519 -C "you@laptop" -f ~/.ssh/id_ed25519
```

Skip `ssh-keygen` if `~/.ssh/id_ed25519` already exists. Install the public key:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub you@192.168.1.8
```

Without `ssh-copy-id`:

```bash
cat ~/.ssh/id_ed25519.pub | ssh you@192.168.1.8 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

After key login works, disable passwords on the remote:

```
# remote /etc/ssh/sshd_config or sshd_config.d/*.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
```

Then `sudo systemctl reload ssh` (or `sshd`).

### 4. Write `~/.ssh/config` and test

```ssh-config
# ~/.ssh/config  — the picker ignores Host *
Host home-mac
    HostName 192.168.1.8
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Permissions:

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/config ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

```bash
ssh -o BatchMode=yes home-mac true    # must succeed with zero prompts
```

The same remote can have **several Host aliases** (LAN at home, Tailscale on the road): [Several Hosts for one machine](#several-hosts-for-one-machine).

---

## LAN

Laptop and remote on the same L2 network (home Wi-Fi, office ethernet): use the private address. Lowest latency.

### Find the remote’s LAN IP

```bash
# macOS (Wi-Fi is often en0)
ipconfig getifaddr en0

# Linux
hostname -I
ip -4 addr show
```

Typical ranges: `192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`. Do not put `127.0.0.1` in the laptop’s `HostName`.

Reserve a DHCP lease / static IP on the router so the address does not move after a reboot.

### `~/.ssh/config`

```ssh-config
Host home-mac
    HostName 192.168.1.8
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

```bash
ping -c 1 192.168.1.8
ssh home-mac true
faragent doctor --host home-mac
```

### Limits

Leave that network (café, phone hotspot, a VPN that replaces the LAN) and it stops working. For a path from elsewhere, use [Tailscale](#tailscale-for-nat-traversal-recommended) or a [public IP / domain](#public-ip).

Guest Wi-Fi and AP / client isolation also block host-to-host pings. Switch to the main LAN and retry.

---

## Public IP

Use this when the remote has an address the public internet can hit: a cloud VM, home WAN with a real public IPv4, or a global IPv6.

### Cloud VM

1. Copy the instance’s public IP from the console.
2. Security group / firewall: allow **your source IP** to TCP 22 (or the SSH port you chose). Do not leave `0.0.0.0/0` open unless you accept scanners showing up within minutes.
3. Put that IP in `HostName`.

```ssh-config
Host gpu-box
    HostName 203.0.113.10
    User coder
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Add `Port 2222` if sshd is not on 22.

### Home machine behind a router

1. Get [LAN SSH](#lan) working first.
2. Look up the WAN IPv4 (from the remote or any device at home):

   ```bash
   curl -4 https://ifconfig.me
   ```

3. On the router, **port-forward** WAN TCP 22 (or 2222) to the remote’s LAN IP:22.
4. Test from phone LTE (Wi-Fi off): `ssh -p 22 you@PUBLIC_IP true`. Testing the public IP from inside the house often fails (NAT hairpin) even when the forward works from outside.

**CGNAT:** if `curl`’s IP is **not** the address on the router WAN port, you likely have no real public IPv4 and forwards will never arrive. Skip this section and use [Tailscale](#tailscale-for-nat-traversal-recommended).

**IPv6:** a global address can go straight into config:

```ssh-config
Host home-mac-v6
    HostName 2001:db8::8
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

The laptop needs working IPv6 too.

### Security

A public `sshd` is scanned within minutes. Anyone who can SSH in can run that user’s agents and read their repos. Minimum:

- Keys only, passwords off (see above)
- Lock the security group to your source IPs; at home, prefer **not** forwarding 22 and use Tailscale instead
- Keep OpenSSH updated

---

## Domain

A domain is a name for a public IP (or IPv6). SSH still connects to whatever that name resolves to; it does **not** bypass NAT. If the home WAN has no public IP, a domain alone does nothing.

### DNS records

| Record | Value | When |
| --- | --- | --- |
| `A` | Public IPv4 | You have IPv4 |
| `AAAA` | Public IPv6 | You have IPv6 |
| Dynamic DNS | Client updates A/AAAA | Home IP changes |

Changing home IP: use the router’s DDNS, or Cloudflare / DuckDNS (or similar) plus a small updater on the remote. Keep TTL short.

### `~/.ssh/config`

```ssh-config
Host gpu-box
    HostName gpu.example.com
    User coder
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    # Port 2222
```

```bash
dig +short gpu.example.com
ssh gpu-box true
faragent doctor --host gpu-box
```

The `Host` alias (`gpu-box`) and `HostName` (real DNS name) may differ. The FarAgent list shows `Host`.

---

## Tailscale for NAT traversal (recommended)

[Tailscale](https://tailscale.com/) builds a WireGuard mesh (a tailnet) on each device. Every machine gets a stable `100.x.y.z` address, and usually a MagicDNS name.

For FarAgent: remote `sshd` **stays off the public internet**. No port forward. Café, LTE, and home all use the same Host as long as both sides are logged into Tailscale.

This is **SSH over Tailscale** (system `sshd` + your SSH keys, traffic on the Tailscale interface). That is not the product feature **Tailscale SSH** (`tailscale set --ssh`, Tailscale identity as login). FarAgent needs BatchMode + `IdentityFile`; use the former.

Official: [Protect SSH servers using Tailscale](https://tailscale.com/kb/1009/protect-ssh-servers), [Install](https://tailscale.com/docs/install/linux).

### 0. Before you start

- A Tailscale account (the personal free plan is enough for a laptop plus a few home machines). Sign up at [https://login.tailscale.com](https://login.tailscale.com).
- Install Tailscale on **both** the remote and the laptop, **same account**.
- Remote already has `sshd` and your public key, as above.

If the current network cannot load the Tailscale login page, fix control-plane connectivity first — or use a public IP/domain, or self-host Headscale (out of scope here).

### 1. Install and log in on the remote

**Linux remote** (same script as the [Linux install docs](https://tailscale.com/docs/install/linux)):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

The command prints a URL. Open it, authenticate, approve the machine.

Prefer not to `curl | sh`: install from [Tailscale Packages](https://pkgs.tailscale.com/stable/) for your distro, then `sudo tailscale up`.

**macOS remote**

1. Prefer the **Standalone** package: [https://pkgs.tailscale.com/stable/#macos](https://pkgs.tailscale.com/stable/#macos) (full CLI). The [Mac App Store](https://apps.apple.com/app/tailscale/id1475387142) build also works.
2. Open Tailscale, install the VPN configuration, sign in with the **same account**.
3. The menu-bar icon should read Connected.

**Windows remote (Tailscale)**

Native Windows: install Tailscale on the Windows host itself — `sshd` (Win32 OpenSSH) and Tailscale share that network stack, so the `100.x` address just works. WSL2: install Tailscale **inside the distro** (Linux steps) so `tailscale ip -4` and `sshd` share a network namespace; Tailscale only on the Windows host, SSH to WSL’s port 22, usually will not match.

When login succeeds, on the remote:

```bash
tailscale status
tailscale ip -4
```

Note the `100.` address and the machine name (MagicDNS uses it). Confirm the device is online under [Machines](https://login.tailscale.com/admin/machines).

### 2. Install and log in on the laptop

**macOS laptop:** Standalone or App Store, **same account**, menu bar Connected.

**Linux laptop:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

When both sides are Connected, on the **laptop**:

```bash
tailscale status
ping -c 2 100.x.y.z          # remote Tailscale IPv4
```

The remote should show `active` in `tailscale status`, not `offline`. A working ping means the tunnel is up (peer-to-peer or DERP relay; relay is a bit slower, FarAgent still works).

### 3. Write `~/.ssh/config`

**A — Tailscale IP (most reliable, no DNS)**

```ssh-config
Host home-mac
    HostName 100.101.102.103
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Replace `100.101.102.103` with `tailscale ip -4` **on the remote**. That address stays stable until the device is removed from the tailnet.

**B — MagicDNS**

New tailnets have [MagicDNS](https://tailscale.com/docs/features/magicdns) on by default. Check [DNS settings](https://login.tailscale.com/admin/dns). Then you can use the machine name:

```ssh-config
Host home-mac
    HostName home-mac
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Or the FQDN `home-mac.<your-tailnet>.ts.net` (shown on the Machines page). `Host` and the MagicDNS name may differ. If the short name does not resolve, use `100.x` or the FQDN.

### 4. Check, then open FarAgent

```bash
ssh -o BatchMode=yes home-mac true
faragent doctor --host home-mac
faragent
```

Pick `home-mac` in the TUI. Probe, agent install, and tmux attach all use this SSH path.

### 5. Day-to-day

- **Tailscale must be up on both sides.** Linux install usually enables `tailscaled`. On macOS, start Tailscale at login.
- Switching Wi-Fi / LTE may stall an existing SSH while Tailscale re-peering. Live agent sessions stay in remote tmux; only the laptop SSH drops — reattach `[live]`.
- After laptop sleep, if `ssh home-mac true` fails, check Connected in the menu bar / `tailscale status` first.
- Key expiry (if enabled on the account): run `sudo tailscale up` on that device and sign in again when the console says so.
- **Do not** port-forward 22 “for Tailscale”. Leaving sshd on the tailnet only is the point.
- You do not need `tailscale set --ssh`. That intercepts tailnet traffic to port 22 and is a different path from system sshd + keys.

### Tailscale troubleshooting

| Symptom | What to try |
| --- | --- |
| Remote `offline` in `tailscale status` | Client not running, or a different account |
| `ping` to `100.x` fails | Wait a few seconds. Captive / UDP-blocked networks fall back to DERP (slower, should still work). Check Shields up is off |
| MagicDNS short name fails | Set `HostName` to `100.x` or `xxx.ts.net`; enable MagicDNS in the admin console |
| `Permission denied` | Not Tailscale: key / `User` / `authorized_keys` as for any SSH |
| Login page will not load | Control plane blocked; switch networks or use a public IP |
| WSL2 unreachable | Install Tailscale in the distro that runs sshd |

More: [Tailscale troubleshooting](https://tailscale.com/docs/reference/troubleshooting).

---

## Several Hosts for one machine

The picker lists `Host` aliases. Give the same remote two names so home LAN does not hairpin through the VPN:

```ssh-config
Host home-mac-lan
    HostName 192.168.1.8
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

Host home-mac
    HostName 100.101.102.103
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Use `home-mac-lan` at home (lower latency) and `home-mac` on the road. FarAgent treats them as two Hosts; remote tmux sessions are the same set — attach from either alias.

---

## Password-only servers (optional)

Some machines only take an account password: a temporary account a colleague handed you, a freshly installed server with no `authorized_keys` yet, or an sshd with `PubkeyAuthentication no`. FarAgent supports that path:

1. Switch the Host to password mode: `faragent auth --host home-mac --mode password` (or press `g` in the TUI host list until it says `[password]`).
2. Do one interactive login: `faragent login --host home-mac` (in the TUI, press `a` on the error screen).
3. After that FarAgent reuses the connection; by default you are not asked again for 4 hours.

What this does and does not do:

- The password goes **only into system OpenSSH**. FarAgent never reads it, forwards it, writes it to config, or logs it.
- A successful login leaves a ControlMaster socket (`~/.faragent/cm/`, mode `0700`). Probe, session listing, and attach all ride it, so you are not asked repeatedly.
- When that connection drops or outlives `ControlPersist` (4 hours in password mode), run `faragent login` once more.
- The first connection also asks for the host key fingerprint (`yes/no`); verify it and answer `yes` during the interactive login.
- `faragent doctor` prints the current mode; `faragent auth --host home-mac --mode auto` goes back to the default (keys first, prompt only if the server demands it).

```bash
faragent auth --host home-mac --mode password   # switch
faragent login --host home-mac                  # type the password once / accept the host key
faragent doctor --host home-mac                 # then use it normally
```

> Keys are still sturdier: no dependency on a live multiplexed connection, and individually revocable. Once keys work, `faragent auth --host home-mac --mode auto`.

## Windows client notes

Windows 11 works as a client (Windows Terminal is the supported terminal). Two platform differences matter:

- **No connection multiplexing.** Windows' built-in ssh cannot create ControlMaster sockets, so FarAgent omits them entirely. Every command opens its own short SSH connection — same behavior, slightly more handshakes. `faragent doctor` says `multiplex: not supported by this ssh build`.
- **Password hosts go through memory.** With no multiplexed connection to reuse, the TUI asks for the password itself (press `a` on the error screen, or it prompts up front for hosts pinned to password mode) and keeps it in this process only — never written to disk, cleared when faragent exits. ssh reads it through `SSH_ASKPASS`: OpenSSH calls faragent again as its askpass helper, and the secret travels over a loopback socket behind a one-time token. It answers **password prompts only** — host-key confirmations and key passphrases still go through `faragent login`, so the first-connect fingerprint check keeps its meaning.

If endpoint protection blocks the askpass helper, fall back to keys / ssh-agent:

```powershell
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\id_ed25519
```

---

## When it fails: error, cause, fix

FarAgent does not guess, and it does not stop at "connection failed": it keeps the **verbatim ssh output**, then names the cause and the exact commands to run. On the TUI error screen: `j/k` scroll, `a` interactive login, `r` retry, `y` copy the whole report, `Esc` back. `faragent doctor --host X` and `faragent probe --host X` print the same report.

| Raw error (verbatim ssh output) | Cause | Fix |
| --- | --- | --- |
| `'ssh' is not recognized as an internal or external command` (or 无法将"ssh"项识别为 cmdlet) | The local OpenSSH client is missing on Windows | Settings → System → Optional features → Add a feature → **OpenSSH Client** (or `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0` in an admin PowerShell), then reopen the terminal |
| `Permission denied (publickey).` | The server refused the key: not installed, wrong `User`, or remote permissions | `ssh -v <Host> true` to see which key was offered; `ssh-copy-id -i ~/.ssh/id_ed25519.pub <Host>`; add `IdentityFile` + `IdentitiesOnly yes`; password-only servers: see above |
| `Permission denied (publickey,password).` | The server accepts passwords, but FarAgent cannot type one by itself | `faragent auth --host <Host> --mode password`, then `faragent login --host <Host>` (or `a` in the TUI) |
| `Too many authentication failures` | Too many keys in the agent; the server hung up before reaching yours | Pin one: `IdentityFile` + `IdentitiesOnly yes`; `ssh-add -D` to drop the rest |
| `Host key verification failed.` | The host key is not in `known_hosts` yet | `faragent login --host <Host>`, verify the fingerprint, answer `yes` (or `ssh-keyscan` first and compare) |
| `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!` | The host key changed: reinstall, rebuilt VM, or interception | Check `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the remote, then `ssh-keygen -R <Host>` (non-22 ports: `ssh-keygen -R "[<Host>]:<port>"`) |
| `WARNING: UNPROTECTED PRIVATE KEY FILE!` / `Permissions 0644 ... are too open` | A local `~/.ssh` file is too permissive or wrongly owned | `chmod 700 ~/.ssh && chmod 600 ~/.ssh/config ~/.ssh/id_ed25519 ~/.ssh/known_hosts` |
| `Load key "...": invalid format` | Corrupt private key, or `IdentityFile` points at a `.pub` | Regenerate with `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519`, then `ssh-copy-id` |
| `Enter passphrase for key '...'` | The key has a passphrase no agent remembers | `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` (Linux: `ssh-add ~/.ssh/id_ed25519`) |
| `No such identity` / `Identity file ... not accessible` | `IdentityFile` points at a file that is not there | `grep -n -i identityfile ~/.ssh/config`, fix the path or generate the key |
| `Could not resolve hostname` | Name does not resolve: `HostName` typo, DNS, or an internal name needing VPN / Tailscale | `dig +short <HostName>`; `tailscale status`; put a reachable IP in `HostName` |
| `Connection refused` | The host answers but nothing listens: sshd stopped, wrong port, or a firewall reject | On the remote `sudo systemctl status ssh` (macOS: enable Remote Login); `nc -vz <Host> <port>`; open the security group |
| `Operation timed out` | No response at all: unreachable address, dropped packets, or a hung login shell | `ping -c 2 <Host>`, `nc -vz <Host> <port>`; remove anything that waits for input from `~/.bashrc` |
| `No route to host` / `Network is unreachable` | No route to that address from this machine | Change networks, bring up Tailscale / VPN, or use a public IP / domain |
| `kex_exchange_identification: Connection closed by remote host` | The handshake was closed: sshd not really running, an IP ban, or `hosts.deny` | Wait a few minutes; on the remote `sudo systemctl status ssh`; check `hosts.allow` / `hosts.deny` |
| `no matching key exchange method found. Their offer: ...` | Old sshd offering only ssh-rsa / legacy KEX | Try `ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostkeyAlgorithms=+ssh-rsa <Host> true`, then put those options in `~/.ssh/config` |
| `bash: ...` / probe output missing `FARAGENT_PROBE_V1` | SSH works, but the remote login shell did not run bash | `ssh <Host> -- bash -lc 'echo ok'`; make sure bash exists and `~/.bashrc` / `~/.bash_profile` has no `read` / `ssh-add` style blocking command |

Pressing `y` on the error screen copies **the cause + the raw output + the steps above** to your clipboard, ready to paste to a colleague or into an issue.

---

## After SSH works

```bash
ssh home-mac true
faragent doctor --host home-mac
faragent
```

Password-only server? Two more steps:

```bash
faragent auth --host home-mac --mode password   # or press g in the TUI host list
faragent login --host home-mac                  # type the password once (FarAgent stores nothing)
```

Everyday flow: [User guide](user-guide.md). SSH into the machine is full access to that user’s agents and repos — protect keys, passwords, sshd, and the Tailscale account accordingly.

## See also

- [Password-only servers (optional)](#password-only-servers-optional)
- [When it fails: error, cause, fix](#when-it-fails-error-cause-fix)
- [User guide · SSH config](user-guide.md#ssh-config)
- [Security](security.md)
- [Tailscale download](https://tailscale.com/download) · [Linux install](https://tailscale.com/docs/install/linux) · [macOS install](https://tailscale.com/docs/install/mac) · [MagicDNS](https://tailscale.com/docs/features/magicdns)
