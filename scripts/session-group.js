#!/usr/bin/env node
/**
 * Print the in-group session name for a Discord reply endpoint.
 * Usage: node scripts/session-group.js <endpoint>
 * Success: group name on stdout, exit 0. Invalid input: message on stderr, exit 1.
 */
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node scripts/session-group.js <endpoint>');
  process.exit(1);
}
try {
  process.stdout.write(`${sessionGroupFromEndpoint(args[0])}\n`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
