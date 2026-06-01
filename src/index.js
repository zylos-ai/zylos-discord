#!/usr/bin/env node
/**
 * zylos-discord
 *
 * Discord bot channel for Zylos agents
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';

// Initialize
console.log(`[discord] Starting...`);
console.log(`[discord] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[discord] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[discord] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[discord] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[discord] Component disabled, stopping...`);
    shutdown();
  }
});

// Main component logic
async function main() {
  // TODO: Implement your component logic here
  //
  // Communication components: set up platform SDK, listen for events, forward to C4
  // Capability components: start HTTP server or other service interface
  // Utility components: run task and exit (remove the keepalive below)

  console.log(`[discord] Running`);
}

// Graceful shutdown
function shutdown() {
  console.log(`[discord] Shutting down...`);
  // TODO: Close connections, stop listeners, cleanup
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[discord] Fatal error:`, err);
  process.exit(1);
});
