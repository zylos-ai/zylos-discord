# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
