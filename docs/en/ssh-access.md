# SSH access: LAN, public IP, domain, Tailscale

**English** · [中文](../zh/ssh-access.md)

FarAgent does **not** punch NAT for you. It reads concrete `Host` entries from `~/.ssh/config` and runs system OpenSSH in **BatchMode** (key-only, no password prompt).

This chapter has one job: make `ssh <Host> true` work on the network you actually use. After that, pick the same Host in the TUI.

Four usual ways in:

| Where you are | Use | Router changes? |
| --- | --- | --- |
| Same Wi-Fi / same office LAN | [LAN IP](#lan) | No |
| Cloud VM, or home WAN with a real public IPv4/IPv6 | [Public IP](#public-ip) | Home WAN usually needs port forward |
| Public IP changes, or you want a name | [Domain](#domain) | Home WAN still needs a forward |
| Home box behind NAT / CGNAT, or you need a café / LTE path | [Tailscale (recommended)](#tailscale-for-nat-traversal-recommended) | **No** |

v0.1 does **not** support password SSH, OTP, or `ProxyJump`. Jump hosts and “connect through frp first” are not Hosts FarAgent can use. A tunnel that looks like a direct address (for example `HostName 127.0.0.1` plus a local forwarded port) can work; Tailscale is less work.

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
ssh -o BatchMode=yes home-mac true
faragent doctor --host home-mac
```

If `BatchMode=yes` fails, FarAgent will fail the same way (password prompt or missing key).

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

**Windows remote (v0.1)**

SSH into **sshd inside WSL2**, not Win32 OpenSSH. Install and start `ssh`/`sshd` in the distro as on Linux.

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

FarAgent accepts keys / ssh-agent only.

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

**Windows remote + WSL2**

FarAgent talks to sshd **inside WSL2**. Install Tailscale in **that same distro** (Linux steps) so `tailscale ip -4` and `sshd` share a network namespace. Tailscale only on the Windows host, SSH to WSL’s port 22, usually will not match.

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

## After SSH works

```bash
ssh home-mac true
faragent doctor --host home-mac
faragent
```

Everyday flow: [User guide](user-guide.md). SSH into the machine is full access to that user’s agents and repos — protect keys, sshd, and the Tailscale account accordingly.

## See also

- [User guide · SSH config](user-guide.md#ssh-config)
- [Security](security.md)
- [Tailscale download](https://tailscale.com/download) · [Linux install](https://tailscale.com/docs/install/linux) · [macOS install](https://tailscale.com/docs/install/mac) · [MagicDNS](https://tailscale.com/docs/features/magicdns)
