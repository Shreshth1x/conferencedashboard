import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const testDirectory = mkdtempSync(join(tmpdir(), 'conference-desk-e2e-'));
const origin = 'http://127.0.0.1:4175';
process.once('exit', () => rmSync(testDirectory, { recursive: true, force: true }));

export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  workers: 1,
  use: { baseURL: origin, channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1360, height: 960 } },
  webServer: {
    command: 'npm run dev',
    url: `${origin}/api/workspace`,
    timeout: 20_000,
    reuseExistingServer: false,
    env: {
      PORT: '4175',
      NODE_ENV: 'development',
      CONFERENCE_DATA_DIR: testDirectory,
      GMAIL_CLIENT_ID: '',
      GMAIL_CLIENT_SECRET: '',
      GMAIL_REDIRECT_URI: `${origin}/api/gmail/callback`,
      APOLLO_API_KEY: '',
      AUTUMN_API_KEY: '',
      EXA_API_KEY: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: '',
      CODEX_BIN: join(testDirectory, 'codex-disabled'),
    },
  },
});
