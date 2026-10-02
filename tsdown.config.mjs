import { defineConfig } from 'tsdown'

// tsdown bundles src/index.ts into lib/index.js (ESM) and emits lib/index.d.ts.
// It is also the self-contained `prepare` script for git installs: no project
// references, no type checking (see guide §7.1 "build-script catch").
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  sourcemap: false,
  outDir: 'lib',
  // platform: 'node' 时 fixedExtension 默认为 true → 产出 lib/index.mjs，
  // 与 package.json#main（lib/index.js）对不上，插件会加载失败。
  // 关掉它，让产物落回 .js / .d.ts。
  fixedExtension: false,
})
