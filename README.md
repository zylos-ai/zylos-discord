<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-discord</h1>

<p align="center">
  Discord bot channel for Zylos agents
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

- **Gateway connection** - persistent Discord Gateway WebSocket; no public
  webhook or Caddy route required.
- **DM and server access control** - owner binding, DM policies, server
  allowlists, mention mode, smart mode, and DM pairing approval.
- **Rich Discord events** - forwards replies, attachments, voice-note
  transcripts, stickers, reactions, edits, deletes, forum/media-root threads,
  and outbound native polls.

## Install

```bash
zylos add discord
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zylos-ai/zylos-discord.git discord
cd discord && npm install
```

## Configuration

Edit `~/zylos/components/discord/config.json`:

```json
{
  "enabled": true,
  "botToken": "DISCORD_BOT_TOKEN",
  "owner": "123456789012345678",
  "dmPolicy": "pairing",
  "groupPolicy": "allowlist",
  "channels": {
    "234567890123456789": {
      "name": "general",
      "mode": "mention",
      "allowFrom": ["123456789012345678"]
    }
  }
}
```

## Usage

```bash
# Manage owner, DM policy, server channels, and allowlists
node ~/zylos/.claude/skills/discord/scripts/admin.js --help

# Add a server channel in mention mode; it defaults to owner-only access
node ~/zylos/.claude/skills/discord/scripts/admin.js add-channel 234567890123456789 general mention

# Allow all senders for a configured server channel
node ~/zylos/.claude/skills/discord/scripts/admin.js set-channel-allowfrom 234567890123456789 '*'

# Send an outbound C4 reply to Discord; message content is read from stdin
cat message.txt | node ~/zylos/.claude/skills/discord/scripts/send.js "234567890123456789|msg:345678901234567890"
```

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
