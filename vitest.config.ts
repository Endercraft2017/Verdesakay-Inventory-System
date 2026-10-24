import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    // Before any test file's imports: never let a test reach the real db/ folder.
    setupFiles: ['tests/setup-safe-paths.ts'],
    // Integration tests share one SQLite file via DB_PATH, so run serially
    // to keep assertions deterministic.
    fileParallelism: false,
    // Full real-KDF integration flows need a bounded harness budget on slower runners.
    // Product request deadlines and explicit elapsed-time assertions remain separate.
    hookTimeout: 60000,
    testTimeout: 60000,
  },
});
