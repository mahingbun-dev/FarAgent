# SSH 连接：局域网、公网 IP、域名、Tailscale

[English](../en/ssh-access.md) · **中文**

FarAgent **不自己做网络穿透**。它只读本机 `~/.ssh/config` 里的具体 `Host`，再用系统 OpenSSH 以 **BatchMode**（密钥免密、不弹密码）连过去。

所以本章的目标只有一句：让 `ssh <Host> true` 在你真正使用 faragent 的那张网上成功。成功之后，TUI 里选这个 Host 即可。

四种常见连法：

| 你在哪、机器在哪 | 用什么 | 要不要改路由器 |
| --- | --- | --- |
| 同一 Wi-Fi / 同一办公室网 | [局域网 IP](#局域网) | 否 |
| 云主机，或家宽有真正的公网 IPv4/IPv6 | [公网 IP](#公网-ip) | 家宽通常要端口转发 |
| 公网 IP 会变，或想记一个名字 | [域名](#域名) | 家宽通常仍要端口转发 |
| 家宽在 NAT / CGNAT 后面，或要在咖啡馆、4G 连家里 | [Tailscale 内网穿透](#用-tailscale-做内网穿透推荐) | **否（推荐）** |

v0.1 **不支持** 密码 SSH、OTP、`ProxyJump`。跳板机、frp 的「先跳再连」写不成 FarAgent 能用的 Host。把隧道做成 **看起来像直连** 的地址（例如本机端口转发到 `127.0.0.1`）可以，但更省事的是 Tailscale。

---

## FarAgent 对 SSH 的要求

选择器只列出 **非通配** 的 `Host`。`Host *`、`Host *.github.com` 会被跳过。

`HostName` 可以是下面任意一种，FarAgent 不区分：

- 局域网地址：`192.168.1.8`、`10.0.0.4`
- 公网 IPv4 / IPv6
- 域名：`gpu.example.com`、`home.example.com`
- Tailscale：`100.x.y.z`，或 MagicDNS 名

打开 TUI 之前先确认：

```bash
ssh -o BatchMode=yes home-mac true
faragent doctor --host home-mac
```

`BatchMode=yes` 失败 = 还在要密码或密钥没配对。FarAgent 同样会失败。

---

## 所有方式共用：打开 sshd，配好密钥

先做完这一节，再选局域网 / 公网 / 域名 / Tailscale。

### 1. 远程打开 SSH 服务

**macOS 远程**

系统设置 → 通用 → 共享 → **远程登录**（打开）。或：

```bash
sudo systemsetup -setremotelogin on
```

**Linux 远程**

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

**Windows 远程（v0.1）**

SSH 必须进 **WSL2 里的 sshd**，不要用 Win32 OpenSSH。在发行版里按 Linux 的方式安装并启动 `ssh`/`sshd`。

确认服务在跑：

```bash
# Linux
sudo systemctl status ssh    # 或 sshd

# 本机先试环回（在远程自己敲）
ssh -o BatchMode=yes localhost true
```

### 2. 防火墙放行 22（只给该走的网）

- **局域网 / Tailscale：** 只需要本机防火墙允许 SSH。Tailscale 网卡上的 22 **不必** 对公网开放。
- **公网 IP / 域名：** 还要在云安全组或家用路由器上放行（见后文）。风险更高，见 [公网 IP](#公网-ip)。

Linux 示例：

```bash
# ufw
sudo ufw allow OpenSSH
sudo ufw enable

# firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
```

macOS 打开「远程登录」后一般会自动放行。

### 3. 本机生成密钥，拷到远程

FarAgent 只接受密钥 / ssh-agent。没有密钥就生成一把：

```bash
ssh-keygen -t ed25519 -C "you@laptop" -f ~/.ssh/id_ed25519
```

已经有 `~/.ssh/id_ed25519` 就不要覆盖。把公钥放到远程用户的 `~/.ssh/authorized_keys`：

```bash
# 远程此刻还能用密码登录时：
ssh-copy-id -i ~/.ssh/id_ed25519.pub you@192.168.1.8
```

没有 `ssh-copy-id` 时：

```bash
cat ~/.ssh/id_ed25519.pub | ssh you@192.168.1.8 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
```

远程建议关掉密码登录（配好密钥并验证成功之后再改）：

```
# 远程 /etc/ssh/sshd_config 或 sshd_config.d/*.conf
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
```

然后 `sudo systemctl reload ssh`（或 `sshd`）。

### 4. 写 `~/.ssh/config` 并验证

```ssh-config
# ~/.ssh/config  — 选择器会忽略 Host *
Host home-mac
    HostName 192.168.1.8
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

权限：

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/config ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

```bash
ssh -o BatchMode=yes home-mac true    # 必须立刻成功、零交互
```

同一台远程可以写 **多个 Host 别名**（家里用局域网，出门用 Tailscale），见 [一台机器几个 Host](#一台机器几个-host)。

---

## 局域网

笔记本和远程在同一二层网（家里 Wi-Fi、办公室有线）时，用内网地址最简单、延迟最低。

### 在远程查局域网 IP

```bash
# macOS（常见 Wi-Fi 网卡是 en0）
ipconfig getifaddr en0

# Linux
hostname -I
ip -4 addr show
```

常见网段：`192.168.x.x`、`10.x.x.x`、`172.16–31.x.x`。不要把 `127.0.0.1` 写进笔记本的 `HostName`。

路由器里给这台机器做 **DHCP 保留 / 静态 IP**，避免重启后地址变了。

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

### 局限

离开这张网（咖啡馆、手机热点、公司 VPN 把局域网切走）就连不上。要出门也能连：用 [Tailscale](#用-tailscale-做内网穿透推荐)，或给这台机器一个 [公网 IP / 域名](#公网-ip)。

隔离的访客 Wi-Fi、AP 隔离（client isolation）也会让两台设备互相 ping 不通。换到主网络再试。

---

## 公网 IP

远程有一个 **从互联网能直接打到的** 地址时用这一节：云主机、有公网 IPv4 的家宽、或公网 IPv6。

### 云主机

1. 控制台看实例的公网 IP。
2. 安全组 / 防火墙放行 **你的源 IP** 访问 TCP 22（或你改过的 SSH 端口）。不要对 `0.0.0.0/0` 长期开放，除非你清楚扫描和爆破会立刻开始。
3. `HostName` 填这个公网 IP。

```ssh-config
Host gpu-box
    HostName 203.0.113.10
    User coder
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

非 22 端口时加一行 `Port 2222`。

### 家里那台机器（路由器后面）

1. 在 **远程所在的局域网** 先按 [局域网](#局域网) 连通。
2. 查家宽公网 IP（在远程或任意家里的设备上）：

   ```bash
   curl -4 https://ifconfig.me
   ```

3. 登录路由器，把 WAN 的 TCP 22（或 2222）**端口转发** 到远程的局域网 IP:22。
4. 用手机 4G（关掉 Wi-Fi）测：`ssh -p 22 you@公网IP true`。用家里 Wi-Fi 测公网 IP 有时会失败（NAT 回环），这不代表外网不通。

**CGNAT：** 若 `curl` 看到的 IP 和路由器 WAN 口上的 IP **不一致**，你多半没有真正的公网 IPv4，端口转发不会从外网进来。这时不要硬配公网，改用 [Tailscale](#用-tailscale-做内网穿透推荐)。

**IPv6：** 若远程有全局 IPv6，可直接：

```ssh-config
Host home-mac-v6
    HostName 2001:db8::8
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

笔记本也必须有可用的 IPv6。

### 安全

把 `sshd` 暴露在公网 = 几分钟内开始被扫。FarAgent 能 SSH 进这台机器，就等于能跑这个用户的 agent、读写仓库。最低要求：

- 只允许密钥，关掉密码（见上文）
- 安全组尽量锁源 IP；家用环境更推荐 **不要** 转发 22，改用 Tailscale
- 保持 OpenSSH 更新

---

## 域名

域名只是给公网 IP（或 IPv6）一个好记的名字。SSH 仍然打到解析出来的地址；**不会** 因此绕过 NAT。家宽没有公网 IP 时，光配域名没用。

### DNS 记录

| 记录 | 值 | 何时 |
| --- | --- | --- |
| `A` | 公网 IPv4 | 有 IPv4 |
| `AAAA` | 公网 IPv6 | 有 IPv6 |
| 动态 DNS | 由客户端更新 A/AAAA | 家宽 IP 会变 |

家宽 IP 经常变：用路由器自带的 DDNS，或 Cloudflare / DuckDNS 一类服务，在远程放一个小更新脚本。TTL 不要设太长。

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
# 确认解析到你以为的那台机器
dig +short gpu.example.com
ssh gpu-box true
faragent doctor --host gpu-box
```

`Host` 别名（`gpu-box`）和 `HostName`（真实 DNS 名）可以不同。FarAgent 列表里显示的是 `Host`。

---

## 用 Tailscale 做内网穿透（推荐）

[Tailscale](https://tailscale.com/) 在每台设备上建一条 WireGuard 网状网（tailnet）。每台机器得到一个稳定的 `100.x.y.z` 地址，多数情况下还能用 MagicDNS 名互访。

对 FarAgent 来说：远程 `sshd` **继续只听在内网**，不必端口转发，也不必把 22 打到公网。咖啡馆、4G、家里来回切，只要两边 Tailscale 是登录状态，原来的 `Host` 仍然能连。

这是 **SSH over Tailscale**（系统 `sshd` + 你的 SSH 密钥，流量走 Tailscale 网卡）。不要和产品功能 **Tailscale SSH**（`tailscale set --ssh`，用 Tailscale 身份登录）搞混。FarAgent 需要 BatchMode + `IdentityFile`，请用前者。

官方说明：[Protect SSH servers using Tailscale](https://tailscale.com/kb/1009/protect-ssh-servers)、[Install](https://tailscale.com/docs/install/linux)。

### 0. 准备

- 一个 Tailscale 账号（个人免费档通常够自己的笔记本 + 家里几台机器）。打开 [https://login.tailscale.com](https://login.tailscale.com) 注册。
- 远程和笔记本 **都要装 Tailscale，且登录同一个账号**。
- 远程已经按上文开了 `sshd`、配好了 SSH 公钥。

当前网络如果打不开 Tailscale 登录页，先解决控制面连通性；连不上时改用公网 IP/域名，或自建 Headscale（超出本文）。

### 1. 在远程安装并登录

**Linux 远程**（官方安装脚本，与 [Linux 安装文档](https://tailscale.com/docs/install/linux) 相同）：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

终端会打印一个 URL。用浏览器打开、登录、批准这台设备。

不想用 `curl | sh`：到 [Tailscale Packages](https://pkgs.tailscale.com/stable/) 按发行版手动装，再 `sudo tailscale up`。

**macOS 远程**

1. 推荐装 **Standalone** 包： [https://pkgs.tailscale.com/stable/#macos](https://pkgs.tailscale.com/stable/#macos)（CLI 完整）。也可用 [Mac App Store](https://apps.apple.com/app/tailscale/id1475387142)。
2. 打开 Tailscale，按提示安装 VPN 配置，用 **同一个账号** 登录。
3. 菜单栏图标应显示 Connected。

**Windows 远程 + WSL2**

FarAgent 进的是 WSL2 里的 sshd。把 Tailscale 装进 **同一个 WSL 发行版**（按 Linux 步骤），保证 `tailscale ip -4` 和 `sshd` 在同一网络命名空间。只装在 Windows 主机、却 SSH 进 WSL 的 22，地址往往对不上。

登录成功后，在远程执行：

```bash
tailscale status
tailscale ip -4
```

记下 `100.` 开头的地址，以及设备名（MagicDNS 会用到）。到 [Machines](https://login.tailscale.com/admin/machines) 确认这台机器在线。

### 2. 在笔记本安装并登录

**macOS 笔记本：** 同样装 Standalone 或 App Store，**同一个账号**，菜单栏显示 Connected。

**Linux 笔记本：**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

两边都 Connected 之后，在 **笔记本** 上：

```bash
tailscale status
ping -c 2 100.x.y.z          # 换成远程的 Tailscale IPv4
```

`tailscale status` 里远程应是 `active`，不要是 `offline`。`ping` 通了说明穿透已经打好（直连或 DERP 中继均可；中继会稍慢，但不影响 FarAgent）。

### 3. 写进 `~/.ssh/config`

**方式 A — Tailscale IP（最稳，不依赖 DNS）**

```ssh-config
Host home-mac
    HostName 100.101.102.103
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

把 `100.101.102.103` 换成 `tailscale ip -4` 在 **远程** 上的输出。这个地址在设备被从 tailnet 删除之前是稳定的。

**方式 B — MagicDNS**

新 tailnet 默认开启 [MagicDNS](https://tailscale.com/docs/features/magicdns)。可在 [DNS 设置](https://login.tailscale.com/admin/dns) 确认。开启后可用设备名：

```ssh-config
Host home-mac
    HostName home-mac
    User you
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

或写全名 `home-mac.<你的tailnet>.ts.net`（在管理控制台 Machines 页能看到）。`Host` 别名和 MagicDNS 名可以相同，也可以不同。若短名解析失败，改用 `100.x` 或 FQDN。

### 4. 验证后打开 FarAgent

```bash
ssh -o BatchMode=yes home-mac true
faragent doctor --host home-mac
faragent
```

TUI 里选 `home-mac`。之后探测、安装 agent、attach tmux，全部走这条 SSH。

### 5. 日常使用注意

- **两边 Tailscale 都要开着。** 远程开机后 `tailscaled` 应自动起来（Linux 安装脚本一般会 `enable` 服务）。macOS 把 Tailscale 设为登录时启动。
- 换 Wi-Fi / 切 4G 时，已有 SSH 可能短暂卡住；Tailscale 会重打洞。FarAgent 里的 live 会话在远程 tmux，断的只是本机这条 SSH：重新 attach `[live]` 即可。
- 笔记本休眠再打开，若 `ssh home-mac true` 失败，先看菜单栏 / `tailscale status` 是不是还在 Connected。
- 密钥过期（账号开了 key expiry）：按控制台提示在该设备再执行一次 `sudo tailscale up` 并登录。
- **不要** 为了 Tailscale 再去端口转发 22。sshd 只给 tailnet 用更安全。
- 不必开 `tailscale set --ssh`。那会接管 tailnet 里打到 22 的流量，和 FarAgent 用的系统 sshd + 密钥不是同一条路。

### Tailscale 排障

| 现象 | 处理 |
| --- | --- |
| `tailscale status` 里远程 `offline` | 远程没开客户端，或没登录同一账号 |
| ping `100.x` 不通 | 等几秒再试；公司网拦截 UDP 时会走 DERP，稍慢但仍应能通。确认没有开「屏蔽入站」（Shields up） |
| MagicDNS 短名解析失败 | `HostName` 改成 `100.x` 或 `xxx.ts.net`；管理控制台打开 MagicDNS |
| `Permission denied` | 与 Tailscale 无关：密钥 / `User` / `authorized_keys` 仍按普通 SSH 查 |
| 登录页打不开 | 当前网络访问控制面失败；换网络，或改用公网 IP |
| WSL2 连不上 | Tailscale 要装在跑 sshd 的那个发行版里 |

更多：[Tailscale 排障](https://tailscale.com/docs/reference/troubleshooting)。

---

## 一台机器几个 Host

选择器按 `Host` 别名列出条目。同一台远程建议写成两个名字，免得在家还绕一圈 VPN：

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

在家用 `home-mac-lan`（延迟更低），出门用 `home-mac`。FarAgent 把它们当成两台 Host；远程的 tmux 会话是同一份，从哪个别名 attach 都可以。

---

## 连上之后

```bash
ssh home-mac true
faragent doctor --host home-mac
faragent
```

日常用法见 [用户手册](user-guide.md)。能 SSH 进这台机器，就等于能用这个用户的 agent 和代码——按这个标准保护密钥、sshd 和 Tailscale 账号。

## 另见

- [用户手册 · 配置 SSH](user-guide.md#配置-ssh)
- [安全说明](security.md)
- [Tailscale 下载](https://tailscale.com/download) · [Linux 安装](https://tailscale.com/docs/install/linux) · [macOS 安装](https://tailscale.com/docs/install/mac) · [MagicDNS](https://tailscale.com/docs/features/magicdns)
