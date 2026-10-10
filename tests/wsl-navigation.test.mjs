import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

globalThis.window = { matchMedia: () => ({ matches: false }) }
globalThis.document = { documentElement: { setAttribute() {} } }
let persisted = ''
globalThis.localStorage = { getItem: () => null, setItem(_key, value) { persisted = value }, removeItem() {} }
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

test('editor drafts survive navigation and stay isolated by file', () => {
  const s = store.getState()
  s.setEditorDraft('distro-a/wsl.conf', '[boot]\nsystemd=false')
  s.setEditorDraft('distro-b/wsl.conf', '')
  s.setActiveView('docker')
  s.setDockerTab('compose')
  s.setWslSelectedDistro('distro-b')
  assert.equal(store.getState().editorDrafts['distro-a/wsl.conf'], '[boot]\nsystemd=false')
  assert.equal(store.getState().editorDrafts['distro-b/wsl.conf'], '')
  s.clearEditorDraft('distro-a/wsl.conf')
  assert.equal(store.getState().editorDrafts['distro-a/wsl.conf'], undefined)
  assert.equal(store.getState().editorDrafts['distro-b/wsl.conf'], '')
})

test('finishing a save preserves newer edits and clears the saved draft', () => {
  const s = store.getState()
  s.setEditorDraft('compose.yml', 'newer edits')
  s.clearEditorDraft('compose.yml', 'submitted edits')
  assert.equal(store.getState().editorDrafts['compose.yml'], 'newer edits')
  s.clearEditorDraft('compose.yml', 'newer edits')
  assert.equal(store.getState().editorDrafts['compose.yml'], undefined)
})

test('environment drafts never enter persisted settings', () => {
  store.getState().setEditorDraft('.env', 'TOKEN=example-secret')
  const state = JSON.parse(persisted).state
  assert.equal(state.editorDrafts, undefined)
  assert.equal(persisted.includes('example-secret'), false)
})
