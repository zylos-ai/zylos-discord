#!/usr/bin/env node
/**
 * zylos-discord
 *
 * Discord bot channel for Zylos agents.
 */

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { DATA_DIR, getBotToken, getConfig, watchConfig } from './lib/config.js';
import { isSelfOrBotMessage, normalizeGatewayError, validateToken } from './lib/discord.js';

const LOG = '[discord]';

let client = null;
let configWatcherStop = null;
let shuttingDown = false;

console.log(`${LOG} Starting...`);
console.log(`${LOG} Data directory: ${DATA_DIR}`);

async function main() {
  const config = getConfig();
  console.log(`${LOG} Config loaded, enabled: ${config.enabled}`);

  if (!config.enabled) {
    console.log(`${LOG} Component disabled in config, exiting.`);
    process.exit(0);
  }

  const token = getBotToken();
  const check = await validateToken(token);
  if (!check.ok) {
    console.error(`${LOG} token validation failed: ${check.error}`);
    process.exit(1);
  }
  console.log(`${LOG} token OK - bot user ${check.tag || check.username} (${check.id})`);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`${LOG} gateway ready as ${readyClient.user.tag} (${readyClient.user.id})`);
  });

  client.on(Events.MessageCreate, (message) => {
    if (isSelfOrBotMessage(message, client.user?.id)) return;
    // Slice 2: route DMs and guild messages to C4.
  });

  client.on(Events.Error, (err) => {
    console.error(`${LOG} client error: ${err.message}`);
  });

  client.on(Events.ShardError, (err, shardId) => {
    console.error(`${LOG} shard error shard=${shardId}: ${err.message}`);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(`${LOG} shard disconnect shard=${shardId} code=${event?.code}`);
    const normalized = normalizeGatewayError(event);
    if (normalized.disallowedIntents) {
      console.error(`${LOG} ${normalized.message}`);
    }
  });

  client.on(Events.Invalidated, () => {
    console.error(`${LOG} session invalidated; exiting for PM2 restart`);
    shutdown(1);
  });

  configWatcherStop = watchConfig((newConfig) => {
    console.log(`${LOG} Config reloaded`);
    if (!newConfig.enabled) {
      console.log(`${LOG} Component disabled, stopping...`);
      shutdown(0);
    }
  });

  try {
    await client.login(token);
  } catch (err) {
    const normalized = normalizeGatewayError(err);
    console.error(`${LOG} gateway login failed: ${normalized.message}`);
    process.exit(1);
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${LOG} Shutting down...`);
  try {
    configWatcherStop?.();
  } catch {}
  try {
    client?.destroy();
  } catch {}
  process.exit(code);
}

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error(`${LOG} Fatal error:`, err);
  process.exit(1);
});
