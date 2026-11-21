import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await import('../package.json', { with: { type: 'json' } }).then(module => JSON.stringify(module.default)))
const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox110'],
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
  write: false,
  legalComments: 'none',
})
const code = result.outputFiles[0]?.text
if (code === undefined) throw new Error('esbuild produced no Client output')
const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(manifest.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  code.split('\n').map(line => line ? `\t\t${line}` : line).join('\n'),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/client.js'), wrapped, 'utf8')
console.log('built lib/client.js')
