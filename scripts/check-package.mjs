import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (manifest.dependencies['@larksuiteoapi/node-sdk'] !== '1.76.0') throw new Error('Reviewed Feishu SDK version drifted')
if (manifest.exports['.'] !== './lib/index.js' || manifest.exports['./client'] !== './lib/client.js') {
  throw new Error('DSH Host/Client exports are incomplete')
}
const hostModule = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
if (typeof hostModule.apply !== 'function' || !Array.isArray(hostModule.inject)) {
  throw new Error('Host module cannot be imported with apply/inject exports')
}
const client = await readFile(resolve(root, 'lib/client.js'), 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load({')) throw new Error('Client loader wrapper is missing')
if (!client.includes(JSON.stringify(manifest.name))) throw new Error('Client loader id does not match package name')
const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`name: '${manifest.name}'`) || !patch.includes('id: feishu-omni')) throw new Error('Bundle patch does not mount the package')
console.log('package entry points and bundle patch verified')
