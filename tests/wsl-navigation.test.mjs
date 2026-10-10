import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

globalThis.window = { matchMedia: () => ({ matches: false }) }
globalThis.document = { documentElement: { setAttribute() {} } }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window.localStorage = globalThis.localStorage

const sourceUrl = new URL('../src/store/appStore.ts', import.meta.url)
const compiled = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('require', 'exports', 'module', compiled)(
  createRequire(sourceUrl), module.exports, module,
)
const store = module.exports.useAppStore

test('active WSL work keeps its page and distribution selected', () => {
  store.getState().setActiveView('wsl')
  store.getState().setWslView('distro')
  store.getState().setWslSelectedDistro('test-distro')
  store.getState().setWslBusyDistro('test-distro')

  store.getState().setActiveView('docker')
  store.getState().setWslView('install')
  store.getState().setWslSelectedDistro('other-distro')
  assert.equal(store.getState().activeView, 'wsl')
  assert.equal(store.getState().wslView, 'distro')
  assert.equal(store.getState().wslSelectedDistro, 'test-distro')

  store.getState().setWslBusyDistro(null)
  store.getState().setActiveView('docker')
  store.getState().setWslView('install')
  store.getState().setWslSelectedDistro('other-distro')
  assert.equal(store.getState().activeView, 'docker')
  assert.equal(store.getState().wslView, 'install')
  assert.equal(store.getState().wslSelectedDistro, 'other-distro')
})
