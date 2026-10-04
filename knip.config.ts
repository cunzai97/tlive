import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    // The three bundle entries esbuild.config.js builds; anything else is only reachable through them.
    'src/server/main.ts',
    'src/client/main.ts',
    'src/client/providers/claude-setup-wizard.ts',
  ],
  project: ['src/**/*.ts'],
  // Only ignore type exports used in the same file (interface/type definitions).
  // Function/const exports used only in the same file ARE flagged.
  ignoreExportsUsedInFile: { interface: true, type: true },
};

export default config;
