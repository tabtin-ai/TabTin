import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/agent/index.ts',
    'src/tool/index.ts',
    'src/channel/index.ts',
    'src/app/index.ts',
    'src/common/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  noExternal: ['zod'],
});
