/**
 * Bundle both halves:
 *   lib/index.js  — host half, ESM, Node platform (loaded by the Cordis loader)
 *   lib/client.js — client half, CJS wrapped in `window.__ModuleLoader__.load({ id, factory })`
 *
 * The module table the shell shares (react, cordis, slots, primitives) stays
 * external, matching PLATFORM_MODULES in packages/client/web/src/platform.ts.
 */
import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'))

const platformModules = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // Resolved from the host at runtime, never bundled.
  external: ['@deepseek-ai/*'],
  sourcemap: true,
  logLevel: 'info',
})

await build({
  entryPoints: [resolve(here, 'src/client/index.tsx')],
  outfile: resolve(here, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: platformModules,
  banner: {
    js:
      `window.__ModuleLoader__.load({\n` +
      `\tid: ${JSON.stringify(pkg.name)},\n` +
      `\tfactory: (require) => {\n` +
      `\t\tvar module = { exports: {} };\n` +
      `\t\tvar exports = module.exports;\n` +
      `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  },
  footer: { js: `\n\t\treturn module.exports;\n\t}\n});` },
  sourcemap: true,
  logLevel: 'info',
})
