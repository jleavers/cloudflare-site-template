import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'dist', include: ['tests/dist/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'preflight', include: ['tests/preflight/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'sweep', include: ['tests/sweep/**/*.test.{ts,js}'], environment: 'node' } },
    ],
  },
});
