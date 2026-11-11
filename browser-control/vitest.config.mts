import { defineConfig } from 'vitest/config';

// The layer's unit tests: pure functions over recorded CDP payloads. Anything that needs a browser is checked by
// scripts/e2e-browser.mjs in the repository root, with the built extension in Chrome.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
