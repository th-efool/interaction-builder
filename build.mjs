import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

fs.mkdirSync('dist', { recursive: true });

console.log('Bundling interaction-builder subpaths with esbuild...');

const entryPoints = [
  { in: 'src/index.ts', out: 'index' },
  { in: 'src/core/index.ts', out: 'core/index' },
  { in: 'src/runtime/index.ts', out: 'runtime/index' },
  { in: 'src/client/index.ts', out: 'client/index' },
  { in: 'src/react/index.ts', out: 'react/index' },
  { in: 'src/adapters/pg/index.ts', out: 'adapters/pg/index' },
  { in: 'src/adapters/http/index.ts', out: 'adapters/http/index' },
  { in: 'src/adapters/ai/index.ts', out: 'adapters/ai/index' },
  { in: 'src/testkit/index.ts', out: 'testkit/index' },
];

await esbuild.build({
  entryPoints,
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'zod',
    'pg',
    'ai',
    'node:crypto',
    'crypto',
    'node:buffer',
    'buffer',
    'node:stream',
    'stream',
  ],
  jsx: 'automatic',
  sourcemap: true,
});

// Ensure 'use client' directive is preserved at top of React bundle
const reactBundlePath = 'dist/react/index.js';
if (fs.existsSync(reactBundlePath)) {
  const content = fs.readFileSync(reactBundlePath, 'utf8');
  if (!content.startsWith("'use client'")) {
    fs.writeFileSync(reactBundlePath, `'use client';\n${content}`, 'utf8');
  }
}

console.log('Emitting TypeScript declarations with tsc...');
try {
  execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });
} catch (e) {
  console.error('Declaration emission failed:', e);
  process.exit(1);
}

console.log('Build completed successfully.');
