const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

(async () => {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
