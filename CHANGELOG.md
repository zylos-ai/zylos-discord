# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-09

### Added
- Session groups for multi-session zylos-core: DMs are `dm-<channel id>`, guild
  channels, threads and forum posts `channel-<channel id>`, owner admin notices
  `admin`. DM endpoints (messages and reaction/edit/delete events) carry a
  `dm:1` marker so the lookup needs no stored state. `--session-group` is passed only when the installed
  Core lists it in `c4-receive-options.json`, so older Cores see unchanged args.
- `scripts/session-group.js <endpoint>` prints the group for an endpoint (used by
  the scheduler to file tasks in the right group).
- Outbound DM policy: `send.js` looks up the destination channel and sends to a
  DM only if the recipient passes the inbound DM policy (owner always; then
  `dmPolicy` / `dmAllowFrom`). Blocked sends exit 1 with `outbound blocked` and
  send, upload and record nothing. Guild channels are not restricted. If the
  lookup fails, a `dm:1` endpoint is blocked and other endpoints send as before.

### Changed
- c4-receive rejections follow `error.persisted`: already stored -> no reply and
  no resend; not stored -> "please try again later"; unknown -> "may not have
  reached me". Core's error text is logged only, never sent to Discord users.
- No component-side timeout kills c4-receive any more (a kill after Core stored
  the row followed by a retry would deliver the message twice).

## [0.1.1] - 2026-06-05

### Added
- Multi-attachment inbound: forward up to 10 attachments per message, each with
  its own `---- file:` trailer and per-file voice-note transcription; a visible
  non-silent note is emitted when more than 10 attachments are sent.

### Changed
- Message edits now deliver the full edited text (original whitespace preserved,
  capped at 4000 characters) so the agent can read and respond to the edit,
  rather than a short whitespace-normalized preview.

### Fixed
- Service now boots correctly under PM2: the bootstrap is gated on the test-runner
  environment instead of `argv[1]`, which PM2 fork mode overrides with its own
  container wrapper (previously the bot could remain "online" without ever
  connecting to the gateway).

## [0.1.0] - 2026-06-04

### Added
- Discord Gateway WebSocket integration using `discord.js` v14, including
  inbound Discord-to-C4 delivery and outbound C4 replies through `scripts/send.js`.
- Direct-message access control with `dmPolicy` modes for `open`, `allowlist`,
  `owner`, and `pairing`; unknown DM users can be queued for owner
  approve/deny review, and the agent never auto-approves access.
- First-DM owner auto-bind so a fresh bot can establish its owner on initial
  private contact.
- Guild access control with `groupPolicy` modes for `disabled`, `allowlist`,
  and `open`; per-channel `allowFrom` lists with `*` wildcard; owner bypass;
  mention and smart response modes; per-thread mode overrides; and
  owner-only auto-registration on the owner's first bot mention in a channel.
- Admin CLI in `scripts/admin.js` for owner, DM policy/allowlist, DM pairing
  review (`dm-pending`, `dm-approve`, `dm-deny`), group/channel policy,
  channel allowlists, one-shot `set-channel-allowfrom`, `group-*` aliases,
  channel modes, history limits, and reaction notification policy.
- Inbound message handling for text, HTTPS-only size-capped image/file
  attachments, stickers, Discord voice-note STT via Whisper, reply context,
  message edits, message deletes, and reaction notices with
  `reactionNotifyMode` `off`/`own`/`all`.
- Outbound delivery support for 2000-character chunking, Discord replies,
  media uploads, stickers, native polls, forum/thread posting, `[SKIP]`, and
  parseable `RECEIPT` output.
- Thinking and typing indicators using the 💡 reaction and Discord typing
  notifications, including early feedback while inbound media and voice
  transcription are processed.
- Production-readiness hardening for atomic and cross-process-locked
  config/pairing writes, fail-closed malformed pairing state handling, bounded
  LRU message history, typing `.done` file cleanup, per-message thinking
  reaction clearing, delete-event metadata fallback cache, cached-config
  gateway hot paths, collision-resistant inbound media filenames, and
  recording-server port-conflict escalation for supervised restart.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add discord
```

No migration required.
