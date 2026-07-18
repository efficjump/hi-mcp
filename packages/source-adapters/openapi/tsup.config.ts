import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node22',
  external: ['@hi-mcp/capability-ir', '@hi-mcp/source-adapter-core'],
});
