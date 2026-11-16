import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests create discord-* temp dirs; keep them under one root removed after the run.
    globalSetup: ['./test/global-setup.js']
  }
});
