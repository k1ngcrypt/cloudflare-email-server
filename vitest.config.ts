import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      wrangler: {
        configPath: './wrangler.test.toml',
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 20_000,
  },
});
