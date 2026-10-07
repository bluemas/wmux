# Cross-PC A2A (experimental)

> **Goal:** let an agent in a pane on one of your PCs hand work to an agent in
> a pane on another of your PCs on the same LAN, and get the reply back.

Cross-PC A2A connects wmux on two PCs you own, pane to pane. An agent on PC A
sends a task to a linked pane on PC B with `send_message`; B's agent sees it
like any other A2A task, and its reply comes back to the pane on A that sent
it. Both directions work over one connection.

It is **experimental** and **off by default**. Nothing listens and nothing is
visible to another PC until you turn it on, pair, choose what to show, and
accept a link.

This is not LanLink. LanLink (Settings > LAN > LanLink) lets agents on other
machines post read-only messages to this one. Cross-PC A2A is a separate
feature with its own listener, its own credentials and its own settings
section; turning one on does not turn on the other.

## How it works

- **Its own HTTPS listener.** When you turn the feature on, wmux creates a
  self-signed certificate for this PC and serves a small HTTPS listener that
  answers `/api/a2a/*` and nothing else. It is not the phone web server
  (`wmux web`), and it never issues phone or device tokens.
- **Certificate pinning.** An invite carries the SHA-256 fingerprint of that
  certificate. The other PC checks it before it sends a single byte of the
  pairing code or, later, of its credential. A PC that answers with another
  certificate gets nothing.
- **One invite pairs two PCs.** The PC that creates the invite is the
  *server*; the PC that pastes it is the *joiner*. Only the server needs an
  open inbound port. The joiner connects out, sends its messages over that
  connection, and holds a stream open for messages coming back.
- **Nothing is shown by default.** For each paired PC you choose which
  workspaces and panes it may see. A pane you did not choose is invisible to
  that PC: no name, no path, no sign that it exists.
- **Links are made by people.** A link joins one pane on each PC. Someone
  proposes it on one PC, and someone accepts it on the other. Agents cannot
  create links.
- **Messages only.** A task from another PC is delivered as a message to the
  linked pane, through the same approval and hold checks as a local A2A
  task. It never starts a worker or opens a pane on the receiving PC.

## Setup

You need wmux running (with its daemon) on both PCs. In the steps below, PC B
is the one that will accept connections, and PC A is the one that joins it.

1. **Turn it on (PC B).** Open Settings > LAN > **Cross-PC A2A
   (experimental)** and turn on **Accept connections from other PCs**. The
   section shows "Listening on port 45660." when it is up. On Windows, allow
   the firewall prompt if one appears (see
   [Network and firewall](#network-and-firewall)).

2. **Create an invite (PC B).** Under **Invite a PC**, click **Create
   invite** and **Copy**. The invite looks like this:

   ```text
   wmux-a2a://office-pc:45660/K7QM2XPA#sha256=AB:CD:...&alt=10.0.4.21
   ```

   It names this PC (its machine name first, then up to four fallback IPv4
   addresses after `alt=`), the port, a one-time code, and the certificate
   fingerprint. The section lists the addresses the other PC will try. The
   invite is valid for **10 minutes** and survives **5** wrong attempts; one
   invite pairs one PC. Send it to PC A over any channel you trust; it is
   meant to be pasted, not clicked.

3. **Paste it (PC A).** On PC A, open the same section, paste the invite
   under **Paste an invite**, and click **Connect**. PC A does not need
   "Accept connections from other PCs" turned on to join. On success it says
   "Connected to *PC B's name*." PC B now appears on A under **PCs I
   connected to**, and PC A appears on B under **PCs connected to me**.

4. **Choose what to show.** Before anything can be linked, the server side
   decides which of its panes the joiner may see. On PC B, under **PCs
   connected to me**, open PC A's entry and tick the workspaces and panes to
   show it. Leave everything else unticked.
   <!-- verify against PR2b/PR3 before merge -->

5. **Link two panes (PC A, then PC B).** On PC A, right-click the pane that
   should talk to PC B and choose **Connect to a pane on another PC…**. Pick
   PC B, then one of the panes it shows you. Each pane is listed with its
   workspace name, label, agent, working directory and git remote/branch;
   panes on the same git remote as yours are listed first as recommended, and
   a different remote shows a warning. Choose the directions (send, receive,
   or both; both by default) and send the proposal.

   On PC B an acceptance card shows both PCs, workspaces, panes, repositories
   and directions. Accept it there. The link is active once PC B accepts;
   until then PC A shows it as pending.
   <!-- verify against PR2b/PR3 before merge -->

6. **Send work.** The agent in the linked pane on PC A now sees the remote
   pane in `a2a_discover` under an alias of the form `<PC>/<workspace>/<pane>`
   (for example `office-pc/api-server/claude`). It sends to that alias with
   `send_message` exactly as it would to a local pane, and the reply arrives
   back in the sending pane. If the link allows it, PC B's agent can send to
   PC A the same way. Progress and replies are visible with
   `a2a_task_query`.
   <!-- verify against PR2b/PR3 before merge -->

The two PCs do not need to be paired both ways. One pairing carries traffic
in both directions over the joiner's connection.

## Network and firewall

- **Port.** The listener uses TCP **45660** by default (clear of the phone
  web server's 7681 and LanLink's 45651). You can change it in the same
  section (1024–65535). If you change it after pairing, joiners keep the old
  port, so pair them again.
- **Who needs an open port.** Only the server (the PC that created the
  invite) accepts inbound connections. The joiner only connects out. If one
  PC cannot accept inbound connections, make it the joiner.
- **Bind address.** The listener binds all interfaces (`0.0.0.0`). Every
  request still needs a valid peer credential, and pairing needs an open
  invite.
- **No proxy.** The joiner connects directly. `HTTP_PROXY`/`HTTPS_PROXY`
  and similar settings are ignored on purpose, since the connection is
  pinned to one certificate.

### Windows

Windows Defender Firewall applies rules per network profile: **Domain**
(a company network that reaches a domain controller), **Private**, and
**Public**. Check which profile the LAN adapter is in with:

```powershell
Get-NetConnectionProfile
```

The first time the listener starts, Windows may ask whether to allow wmux;
the prompt may tick only Private networks. On a company network the adapter
is usually in the **Domain** profile, so the prompt's choice may not cover it,
and a Group Policy may hide the prompt altogether. To allow the port
explicitly, run in an **administrator** PowerShell on the server PC:

```powershell
New-NetFirewallRule -DisplayName "wmux cross-PC A2A" `
  -Direction Inbound -Protocol TCP -LocalPort 45660 `
  -Action Allow -Profile Domain,Private
```

Use your own port if you changed it. Leave `Public` out unless you have a
reason to include it. If your company manages the firewall centrally, a local
rule may have no effect; ask IT to allow the port.

### macOS

If the application firewall is on (System Settings > Network > Firewall),
macOS asks whether to allow incoming connections for wmux when the listener
starts. Click **Allow**. If you denied it earlier, open **Options…** and set
wmux to "Allow incoming connections". With "Block all incoming connections"
turned on, the Mac can only be a joiner.

### Wi-Fi and the network itself

- Many office and guest Wi-Fi networks use **client (AP) isolation**: devices
  on the same Wi-Fi cannot reach each other at all. Pairing then fails with
  a timeout. Use wired Ethernet, or ask IT whether isolation is on.
- **Wired LAN is recommended** for both PCs. It avoids isolation, keeps the
  address stable, and avoids sleep-related drops.
- Invites use the machine name first. If company DNS does not resolve it, the
  joiner falls back to the IPv4 addresses listed in the invite. After
  pairing, the joiner remembers both the name and the address it reached, so
  a later DHCP address change is not a problem as long as one of them still
  works. The certificate pin, not the address, is what identifies the PC.

## Troubleshooting

When **Connect** fails on the joiner, the message tells you which case it is:

| Message (joiner) | Cause | What to do |
| --- | --- | --- |
| This is not a wmux invite. | The pasted text is not a whole invite. | Copy the entire `wmux-a2a://…` line again. |
| This invite was created on this PC. | You pasted the invite on the PC that created it. | Paste it on the other PC. |
| The other PC's identity does not match this invite. | A different machine answered at that address, or the server's certificate was re-created (for example after its wmux data was reset). | Create a new invite on the server and pair again. Do not try to work around it. |
| The other PC refused the connection. | Nothing listens on that port: the feature is off on the server, wmux is not running there, or the port is wrong. | On the server, check that the section says "Listening on port …" and that the invite's port matches. |
| The other PC did not answer in time. | Usually a firewall dropping the port, Wi-Fi client isolation, or the server is asleep or offline. | Check [Network and firewall](#network-and-firewall). Try the server's IPv4 address, or a wired connection. |
| The other PC's name could not be found on this network. | The machine name does not resolve, and no fallback address answered. | Use a fresh invite; it lists the server's current IPv4 addresses. Or fix the DNS name. |
| This invite has expired or was cancelled. | More than 10 minutes passed, the invite was cancelled or replaced, or it ran out of attempts. | Create a new invite. |
| The invite code was not accepted. | The code does not match the open invite (often a truncated copy). | Copy the whole invite again. Each wrong code uses one of the 5 attempts. |
| That PC finished another pairing with this PC at the same moment. | Two pairings of the same PC raced. | Try again. |
| Too many failed attempts from this PC. | The server is rate-limiting this address after repeated failures. | Wait a minute, then try again with a correct invite. |
| The other PC runs an incompatible wmux version. | The two PCs speak different protocol versions. | Update both PCs to the same wmux version. |

On the server, "Not listening: …" means the listener could not start, most
often because another program already uses the port. Pick another port.

After pairing, if the server's certificate changes (it is re-created only
when it is missing, damaged or within 30 days of expiry), the joiner stops
talking to it and shows the PC as needing to be paired again. No data is sent
to a PC whose certificate does not match.
<!-- verify against PR2b/PR3 before merge -->

## Security model

The trust boundary of this experimental version is **your own PCs**. Pair
only machines you control. Support for colleagues' PCs needs further
hardening and will come later.

- **Why remote work cannot run anything.** A task from another PC is
  delivered as a message to the linked pane, and only to that pane. wmux does
  not spawn a worker, open a pane, or run a command for it, and it goes
  through the same approval and hold checks as a local task. If the process
  in the linked pane changed between sending and delivery, or the pane is
  gone, the task is held for you instead of being delivered or re-routed to
  another pane. What the receiving
  agent decides to do with a message is up to that agent and its own
  permissions, just as with a message you type yourself.
- **What a link covers.** A link joins exactly one pane on each side, in the
  directions you allowed. A paired PC sees only the panes you showed it, can
  propose links only to those, and can send only over links a person on the
  receiving PC accepted. The receiving PC decides which pane a message came
  from by its own link record, never by what the sender claims. A link ends
  when the pane is closed, the pane moves to another workspace, or the
  workspace is archived; restoring an archived workspace does not bring the
  link back.
- **Removing access.** Either PC can end a link at any time; tasks in flight
  on it fail. To end the pairing itself, use **Remove** under "PCs I
  connected to" on the joiner (it also tells the server, when reachable) or
  **Disconnect** under "PCs connected to me" on the server. Turning off
  **Accept connections from other PCs** stops the listener.
- **Where credentials live.** Pairing issues the joiner a peer credential
  that works only on the A2A listener's `/api/a2a/*` routes. It is not a
  phone or device token and opens nothing else. The joiner keeps it in its
  wmux data directory (`a2a/remote-hosts.json`), readable only by your user
  account. The server keeps only a salted hash of it (`a2a/peers.json`). The
  listener's private key is also stored owner-only in `a2a/`.
- **Colleagues' PCs.** Not supported in this version. Before wmux allows
  pairing with a PC someone else controls, the model around execution,
  exposure and acceptance will be tightened.

## Known limitations

- Only the joiner can propose a link. The server accepts or refuses it.
- Links are created by people only; agents cannot propose one.
- Acceptance happens on the server side only; the proposer does not confirm
  again.
- No automatic discovery: pair with an invite. There is no PIN alternative.
- A message arrives in a pane only while the wmux app is open on the
  receiving PC. With only the daemon running, it waits and is delivered when
  the app comes back.
- Accepting a link from a phone is not supported.
- An archived and restored workspace does not get its links back; link the
  panes again.
- wmux does not add firewall rules for you.
- Only basic rate limits apply.
