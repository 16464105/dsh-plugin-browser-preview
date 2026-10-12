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
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'))

// Stamped into the client bundle so the running UI can be identified at a
// glance — "is my page still on the old module?" was a real support cost.
let revision = 'nogit'
try {
  revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
} catch {
  /* not a git checkout */
}
const buildId = `${pkg.version}+${revision}`
const define = { __DSH_BUILD_ID__: JSON.stringify(buildId) }

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
  define,
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
  define,
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
