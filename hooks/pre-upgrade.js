#!/usr/bin/env node
/**
 * Pre-upgrade hook for zylos-discord
 *
 * Called by Claude BEFORE CLI upgrade steps.
 * If this hook fails (exit code 1), the upgrade is aborted.
 *
 * This hook handles:
 * - Backup critical data before upgrade
 * - Validate upgrade prerequisites
 * - Stop dependent services if needed
 *
 * Exit codes:
 *   0 - Continue with upgrade
 *   1 - Abort upgrade (with error message)
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/discord');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[pre-upgrade] Running discord pre-upgrade checks...\n');

// 1. Backup config before upgrade
if (fs.existsSync(configPath)) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.${timestamp}.backup`;
  fs.copyFileSync(configPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  console.log('Config backed up to:', backupPath);
}

// 2. Add any pre-upgrade validations here
// Example: Check if required services are available
// if (!checkDependency()) {
//   console.error('Error: Required dependency not available');
//   process.exit(1);
// }

console.log('\n[pre-upgrade] Checks passed, proceeding with upgrade.');
