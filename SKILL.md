---
name: discord
version: 0.2.0
description: >
  Discord bot channel for Zylos agents. Use when the user wants to communicate
  via Discord — chat with the agent in Discord DMs or server channels, send or
  receive Discord messages and attachments, manage who can reach the bot
  (DM/channel access control), or configure the Discord bot (token, owner,
  per-channel allowlist, mention/smart modes). Connects to Discord over the
  Gateway (WebSocket); no public webhook or Caddy route required.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-discord
    entry: src/index.js
  data_dir: ~/zylos/components/discord
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - data/

# No http_routes: this is a Gateway (outbound WebSocket) component, like
# Telegram long-poll / Slack Socket Mode. It does NOT host a public webhook,
# so it needs no Caddy route and no public URL.

upgrade:
  repo: zylos-ai/zylos-discord
  branch: main

config:
  required:
    # Collected by zylos and piped to hooks/configure.js as stdin JSON.
    - name: DISCORD_BOT_TOKEN
      description: >
        Discord bot token (Developer Portal -> your app -> Bot -> Reset Token).
        The "Message Content Intent" must also be enabled on that Bot page.
      sensitive: true
  optional:
    - name: DISCORD_APPLICATION_ID
      description: >
        Application (client) ID -- used only to render the server-invite URL.
        Not required for the bot to run.

dependencies: []
---

# Discord

Discord bot channel for Zylos. Bridges Discord DMs and server channels to the
Zylos agent over the C4 communication bridge.

> **Manual setup step:** in the Discord Developer Portal -> Bot, enable the
> privileged **Message Content Intent**. Without it, the bot receives empty
> message text in server channels. Then invite the bot to a server using the
> OAuth2 URL (`scope=bot`) before messaging it.

```bash
# Admin CLI -- manage owner, access policies, and per-channel allowlist
node ~/zylos/.claude/skills/discord/scripts/admin.js --help

# Outbound (used by C4 to deliver agent replies; message is read from stdin)
cat message.txt | node ~/zylos/.claude/skills/discord/scripts/send.js "<endpoint>"
```

- **Connection:** Gateway WebSocket (discord.js v14). No webhook / Caddy route.
- **Setup:** bot token + enable Message Content Intent + invite the bot to a server.

## Session Groups (multi-session Core)

With a zylos-core that supports multi-session, each inbound message carries a
session group, so every Discord channel gets its own conversation thread.
Replies still go through the same `reply via` path; nothing changes on the
sending side.

| Conversation | Session group | Example |
|---|---|---|
| DM | `dm-<DM channel id>` | `dm-1234567890123456789` |
| Guild text channel, thread or forum post | `channel-<channel id>` | `channel-987654321098765432` |
| Owner admin notices (DM pairing requests) | `admin` | `admin` |

- Discord threads and forum posts are channels with their own id, so each one is
  its own group. Reply chains inside a channel stay in the channel's group.
- DM endpoints carry a `dm:1` marker set when the message arrives, so the
  lookup needs no stored state; the per-message `msg:` / `req:` parts never
  take part. Replies ignore the marker.
- The group is passed only if the installed Core lists `--session-group` in
  `c4-receive-options.json`; older Cores behave exactly as before.
- If Core rejects a message, Core's raw text goes only to the component log. The
  user gets "please try again later" when Core says nothing was stored, and
  "this message may not have reached me; resend if there is no reply in a few
  minutes" when Core cannot say (or c4-receive fails twice). A rejected group is
  never dropped and resent to the overall group. If Core reports the message as
  already stored, the component sends nothing, does not resend, and clears the
  typing indicator and reaction.

Look up the group for a reply endpoint (prints the in-group name; exits 1 on an
invalid endpoint):

```bash
node ~/zylos/.claude/skills/discord/scripts/session-group.js "<endpoint>"
```

## Access Control

- **Owner:** the first user to DM the bot becomes the owner (admin).
- **DM access:** `dmPolicy` can be `open`, `allowlist`, `owner`, or
  `pairing`. Under `pairing`, unknown DM senders are queued for owner review;
  the agent never auto-approves access.
- **DM pairing commands:** use `dm-pending`, `dm-approve <userId>`, and
  `dm-deny <userId> [reason]` in the admin CLI to review queued DM requests.
- **Guild access:** the owner may use server channels even when `groupPolicy`
  is `disabled`; non-owner server access still follows configured channel and
  sender policy.
- **Server channel defaults:** adding a channel manually with `add-channel` or
  automatically via the owner's first bot mention registers the parent channel
  as `mention` mode with `allowFrom:[ownerId]`. Broaden access explicitly with
  `add-channel-allow <channelId> <userId>` or `add-channel-allow <channelId> *`;
  replace the whole sender list with
  `set-channel-allowfrom <channelId> <userId|*...>`. The runtime treats an
  empty `allowFrom` list as allow-all, but the admin CLI requires at least one
  entry to avoid accidental clear-to-anyone; use `*` as the explicit all-senders
  value.
- **Group aliases:** Discord stores server access as `channels{}`, but
  `group-*` admin commands are aliases of the matching `channel-*` commands
  for cross-channel CLI parity.
- **Reaction notices:** per-channel `reactionNotifyMode` can be `own` (default),
  `all`, or `off`; use `set-channel-reaction-notify` in the admin CLI.
- **Voice STT:** inbound Discord voice-note attachments are transcribed inline
  as `[Voice] ...` when `~/zylos/bin/transcribe` is available. Set
  `voiceTranscription` to `disabled` to skip transcription.

Run any script with `--help` for full options.
