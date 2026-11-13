#!/usr/bin/env node
/**
 * Print the in-group session name for a Discord reply endpoint.
 * Usage: node scripts/session-group.js <endpoint>
 * Success: group name on stdout, exit 0. Invalid input or a conversation whose
 * kind (DM / guild channel) cannot be established: message on stderr, exit 1.
 */
import { resolveSessionGroup, fetchDiscordChannel } from '../src/lib/session-group.js';
import { getBotToken } from '../src/lib/config.js';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node scripts/session-group.js <endpoint>');
  process.exit(1);
}
try {
  const group = await resolveSessionGroup(args[0], {
    lookup: (channelId) => fetchDiscordChannel(channelId, { token: getBotToken() })
  });
  process.stdout.write(`${group}\n`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
