#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-discord
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/discord');
const configPath = path.join(DATA_DIR, 'config.json');

function writeJsonFileAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

console.log('[post-upgrade] Running discord-specific migrations...\n');

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Add more migrations as needed for future versions
    // Migration N: Example
    // if (config.newField === undefined) {
    //   config.newField = 'default';
    //   migrated = true;
    //   migrations.push('Added newField');
    // }

    // Save if migrated
    if (migrated) {
      writeJsonFileAtomic(configPath, config);
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      fs.chmodSync(configPath, 0o600);
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

console.log('\n[post-upgrade] Complete!');
