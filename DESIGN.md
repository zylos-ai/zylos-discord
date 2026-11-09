# zylos-discord Design Document

**Version**: v0.1.0
**Date**: 2026-06-01
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-discord
**Status**: Draft

---

## 1. Overview

zylos-discord is the Discord communication channel for Zylos agents. It
connects a Discord bot account to C4 so Discord DMs, server channels, threads,
attachments, reactions, edits, and deletes can reach the agent, and agent
replies can be delivered back to Discord.

The component uses Discord's Gateway WebSocket via discord.js. It does not host
a public webhook or require a Caddy route.

## 2. Architecture

### 2.1 Component Structure

```
zylos-discord/
  src/
    index.js          — Entry point (start/stop lifecycle)
    lib/              — Core logic modules
  scripts/
    admin.js          — Admin CLI for configuration operations
    send.js           — Outbound message handler (communication components)
  hooks/
    configure.js      — Initial config writer from collected setup values
    pre-upgrade.js    — Pre-upgrade checks
    post-install.js   — Post-install setup
    post-upgrade.js   — Post-upgrade config migration
  SKILL.md            — Component specification for the Zylos agent
  ecosystem.config.cjs — PM2 service configuration
```

### 2.2 Data Flow

Inbound flow:
- `src/index.js` starts a discord.js client with Gateway intents for DMs,
  server messages, reactions, and message content.
- Discord events are authorized against the current config before forwarding.
- Message text, optional reply context, selected media notes/files, reaction
  notices, edit notices, and delete notices are formatted for C4.
- The component calls C4 through `c4-receive.js`, preserving a reply endpoint
  that points back to the Discord channel and source message.

Outbound flow:
- C4 calls `scripts/send.js <endpoint>` with the agent reply on stdin.
- The endpoint identifies the Discord channel, optional source message, and
  request/correlation id.
- `scripts/send.js` posts normal messages, replies, media uploads, stickers,
  native polls, or forum/media-root thread messages through the Discord REST
  API.
- After delivery or `[SKIP]`, it clears typing/thinking state and records
  outbound history through the local internal recording endpoint when available.

## 3. Configuration

### 3.1 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token used for Gateway login and REST API calls |
| `DISCORD_APPLICATION_ID` | No | Discord application/client ID used to render invite URLs |

### 3.2 Config File

Located at `~/zylos/components/discord/config.json`:

```json
{
  "enabled": true
}
```

## 4. Integration with Zylos

### 4.1 Lifecycle

- **Start**: Called by PM2 via `ecosystem.config.cjs`
- **Stop**: Graceful shutdown on SIGTERM

### 4.2 Message Flow

The long-running PM2 process receives Discord events over the Gateway. It
forwards authorized user messages and supported event notices into C4 with a
`discord` channel name and an endpoint containing the Discord channel id,
message id, and request id. C4 later invokes `scripts/send.js` with that
endpoint to deliver the agent's response.

Server channels support mention mode and smart mode. In mention mode, user
messages are forwarded for response only when the bot is mentioned. In smart
mode, messages are forwarded with an instruction allowing the agent to reply
with `[SKIP]` when no response is needed. DM access is controlled by `dmPolicy`
and can use owner approval through DM pairing.

## 5. Security

- The bot token is loaded from component config or environment and is masked in
  admin `show` output.
- Component config and pairing state are written with owner-only file
  permissions.
- DM access is controlled by `dmPolicy`; server-channel access is controlled by
  `groupPolicy`, per-channel `allowFrom`, and owner bypass rules.
- Outbound DMs follow the same DM policy: `send.js` resolves the channel via the
  Discord API (not the `dm:1` marker) and blocks DMs to recipients the inbound
  policy would reject. Guild channels (threads use their parent) must pass the
  inbound channel policy; an unlisted channel only accepts a reply to an
  owner-written message (checked via the Discord API), so owner conversations
  there keep working.
- Unknown DM senders under `dmPolicy:"pairing"` are queued for owner approval;
  the agent never auto-approves access.
- Discord mentions from outbound messages are disabled with
  `allowed_mentions:{parse:[]}`.
- Inbound attachment downloads are size-limited, HTTPS-only, and written under
  the component media directory with sanitized names.
- The internal recording/cleanup HTTP endpoint binds to `127.0.0.1` and
  requires a token-derived header.

## 6. Error Handling

- Startup validates the Discord token before Gateway login and exits for PM2 to
  restart on fatal login/session failures.
- Config changes are hot-reloaded; disabling the component in config triggers a
  graceful shutdown.
- Gateway handler failures are caught and logged per event so one failed event
  does not crash the process.
- C4 delivery is retried once for transient receive failures; rejected messages
  are reported back to the Discord user when possible.
- Media and voice transcription failures degrade to durable skipped/unavailable
  notes instead of dropping the whole message.
- Partial Discord fetch failures degrade by omitting unavailable context or
  event details.

## 7. Design decisions & deferred items

### Deferred (intentionally not built — with rationale)
- **Inbound poll-vote awareness — DEFERRED (2026-06-04, Felix).** Polls are **outbound-only**: the channel can post a native Discord `poll` (via the `[POLL]` send marker → `poll` object), but it does **not** subscribe to `MessagePollVoteAdd` / `MessagePollVoteRemove`, so the agent is **not** notified when users vote or when a poll closes. Rationale: outbound polls cover the core use case (the agent asking a question); vote/result tracking is a meaningful add (event handlers + result aggregation) with no current need. Revisit if a use case needs the agent to act on poll results.
- **Voice-ASR first-run guided recovery — DEFERRED (→ prod-readiness review).** Voice STT auto-detects `~/zylos/bin/transcribe` and degrades silently when absent (no install prompt, no self-create). A future flow: first voice-without-ASR → one-time owner prompt offering to install Whisper, then provision it. Tracked for the production-readiness review.
- **Voice-note "transcribing" indicator — DEFERRED (smoke-test finding).** The 💡 thinking-reaction / typing indicator is set *after* media+transcription resolves, so a slow voice note shows no feedback during the (multi-second) Whisper run. Fix: set the indicator *before* starting transcription.

### Notable decisions made during the build
- **Owner always bypasses `groupPolicy=disabled`** (cross-channel standard, M3).
- **Discord channel adds default owner-only** (`allowFrom:[ownerId]`, mention mode) for both manual `add-channel` and owner-mention auto-add — an intentionally strict, opt-in default (the owner explicitly broadens access; adds never default to allow-all).
- **DM pairing mirrors Zalo, Zalo Personal, and Microsoft Teams:** unknown DM senders are queued for owner approval, pending/denied users are deduplicated to prevent owner-notify spam, and the agent never auto-approves access.
- **CLI group parity:** Discord keeps `channels{}` internally, but `group-*` admin commands alias the matching `channel-*` commands; `set-channel-allowfrom` is the one-shot `allowFrom` setter.
- **No per-slice live deploy** — all slices merged to `main`; one closeout release after live-fire on the final commit.
- **Forum/media-root sends create a thread** (`POST /channels/{id}/threads`); a failed channel-type lookup **fails safe to the normal `/messages` path** rather than aborting the send.
- **Voice transcription forwards a durable `[Voice] <transcript>` to history**, keeping the ephemeral audio path only in the live C4 payload.
