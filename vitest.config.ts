import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // Integration tests share one SQLite file via DB_PATH, so run serially
    // to keep assertions deterministic.
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
