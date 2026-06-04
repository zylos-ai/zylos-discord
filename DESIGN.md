# zylos-discord Design Document

**Version**: v0.1.0
**Date**: 2026-06-01
**Author**: Zylos Team
**Repository**: https://github.com/zylos-ai/zylos-discord
**Status**: Draft

---

## 1. Overview

Brief description of what this component does and why it exists.

## 2. Architecture

### 2.1 Component Structure

```
zylos-discord/
  src/
    index.js          — Entry point (start/stop lifecycle)
    lib/              — Core logic modules
  scripts/
    send.js           — Outbound message handler (communication components)
  hooks/
    UserPromptSubmit  — Claude Code hook for inbound messages (communication)
    post-install.js   — Post-install setup
    post-upgrade.js   — Post-upgrade config migration
  SKILL.md            — Component specification for the Zylos agent
  ecosystem.config.cjs — PM2 service configuration
```

### 2.2 Data Flow

Describe how data flows through the component.

## 3. Configuration

### 3.1 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EXAMPLE_API_KEY` | Yes | API key for the service |

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

Describe how messages are sent and received.

## 5. Security

Describe security considerations (authentication, authorization, data handling).

## 6. Error Handling

Describe error handling strategies.

## 7. Design decisions & deferred items

### Deferred (intentionally not built — with rationale)
- **Inbound poll-vote awareness — DEFERRED (2026-06-04, Felix).** Polls are **outbound-only**: the channel can post a native Discord `poll` (via the `[POLL]` send marker → `poll` object), but it does **not** subscribe to `MessagePollVoteAdd` / `MessagePollVoteRemove`, so the agent is **not** notified when users vote or when a poll closes. Rationale: outbound polls cover the core use case (the agent asking a question); vote/result tracking is a meaningful add (event handlers + result aggregation) with no current need. Revisit if a use case needs the agent to act on poll results.
- **Voice-ASR first-run guided recovery — DEFERRED (→ prod-readiness review).** Voice STT auto-detects `~/zylos/bin/transcribe` and degrades silently when absent (no install prompt, no self-create). A future flow: first voice-without-ASR → one-time owner prompt offering to install Whisper, then provision it. Tracked for the production-readiness review.
- **Voice-note "transcribing" indicator — DEFERRED (smoke-test finding).** The 💡 thinking-reaction / typing indicator is set *after* media+transcription resolves, so a slow voice note shows no feedback during the (multi-second) Whisper run. Fix: set the indicator *before* starting transcription.

### Notable decisions made during the build
- **Owner always bypasses `groupPolicy=disabled`** (cross-channel standard, M3).
- **Discord channel adds default owner-only** (`allowFrom:[ownerId]`, mention mode) for both manual `add-channel` and owner-mention auto-add — an intentionally strict, opt-in default (the owner explicitly broadens access; adds never default to allow-all).
- **DM pairing mirrors Zalo, Zalo Personal, and Microsoft Teams:** unknown DM senders are queued for owner approval, pending/denied users are deduplicated to prevent owner-notify spam, and the agent never auto-approves access.
- **No per-slice live deploy** — all slices merged to `main`; one closeout release after live-fire on the final commit.
- **Forum/media-root sends create a thread** (`POST /channels/{id}/threads`); a failed channel-type lookup **fails safe to the normal `/messages` path** rather than aborting the send.
- **Voice transcription forwards a durable `[Voice] <transcript>` to history**, keeping the ephemeral audio path only in the live C4 payload.
