import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@hi-mcp/capability-ir': new URL('../../capability-ir/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
