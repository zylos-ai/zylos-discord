# zylos-discord Design Document

**Version**: v1.0.0
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

## 7. Future Improvements

- Improvement 1
- Improvement 2
