import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const cliOnly = process.argv.includes('--cli-only');

/**
 * Plugin to surface esbuild errors to the console during watch mode.
 */
const logRebuildPlugin = {
  name: 'log-rebuild',
  setup(build) {
    build.onStart(() => {
      console.log(`[esbuild] build started (${build.initialOptions.entryPoints?.[0] ?? '?'})`);
    });
    build.onEnd((result) => {
      result.errors.forEach((e) => console.error(`[esbuild] error: ${e.text}`));
      if (result.errors.length === 0) {
        console.log(`[esbuild] build finished (${build.initialOptions.entryPoints?.[0] ?? '?'})`);
      }
    });
  },
};

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [logRebuildPlugin],
};

const webviewConfig = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',          // matches tsconfig "jsx": "react-jsx" — no need for React in scope
  jsxImportSource: 'react',  // explicit, matches tsconfig default
  outfile: 'dist/webview.js',
  loader: { '.css': 'css' },
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [logRebuildPlugin],
  define: {
    'process.env.NODE_ENV': production ? '"production"' : '"development"',
  },
};

// The standalone CLI: bundles cli/src + src/shared into one executable script.
const cliConfig = {
  entryPoints: ['cli/src/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'cli/dist/gridflow.js',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
  minify: production,
  logLevel: 'silent',
  plugins: [logRebuildPlugin],
};

function copyStatic() {
  ensureDir('dist/webview.css');
  // esbuild writes the CSS sibling automatically as dist/main.css? It emits dist/webview.css alongside webview.js
  // when the entry imports CSS. No-op here unless we have other static assets.
}

async function run() {
  if (cliOnly) {
    await esbuild.build(cliConfig);
    console.log('[esbuild] CLI build complete');
    return;
  }
  if (watch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[esbuild] watching for changes…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(cliConfig),
    ]);
    copyStatic();
    console.log('[esbuild] build complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
