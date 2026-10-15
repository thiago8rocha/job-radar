import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/live/**/*.live.test.ts'], testTimeout: 120_000, retry: 1 },
});
