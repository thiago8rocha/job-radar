import { build } from 'esbuild';

// The Action entry point and the CLI are bundled into single CommonJS files so that
// consumers can run `uses: <owner>/job-radar@v1` without installing dependencies.
await build({
  entryPoints: { index: 'src/action.ts', cli: 'src/cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
