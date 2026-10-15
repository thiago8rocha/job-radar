import { defineConfig } from 'vitest/config';

export default defineConfig({
  // test/live calls the real sources; it runs on its own schedule (npm run test:live)
  test: { include: ['test/**/*.test.ts'], exclude: ['test/live/**', 'node_modules/**'] },
});
