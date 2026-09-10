import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Keep the JSON logger quiet during tests (config.TESTING gates it).
    env: { TESTING: '1' },
  },
});
