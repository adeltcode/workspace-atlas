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

const compile = url => ts.transpileModule(readFileSync(url, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const sourceUrl = new URL('../src/store/appStore.ts', import.meta.url)
const nodeRequire = createRequire(sourceUrl)
const savedStateModule = {}
new Function('require', 'exports', compile(new URL('../src/store/savedState.ts', import.meta.url)))(nodeRequire, savedStateModule)
const module = { exports: {} }
new Function('require', 'exports', 'module', compile(sourceUrl))(
  id => (id === './savedState' ? savedStateModule : nodeRequire(id)), module.exports, module,
)
const store = module.exports.useAppStore
const savedNow = () => {
  module.exports.savedState.flush()
  return persisted
}

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

test('a jump opens the right place, unless WSL work is keeping the user where they are', () => {
  const s = store.getState()
  s.jumpToDocker('containers', 'web', true)
  assert.equal(store.getState().activeView, 'docker')
  assert.equal(store.getState().dockerTab, 'containers')
  assert.deepEqual(store.getState().dockerJump, { tab: 'containers', query: 'web', logs: true })
  s.clearDockerJump()
  assert.equal(store.getState().dockerJump, null)

  s.jumpToPorts('8000')
  assert.equal(store.getState().activeView, 'ports')
  assert.equal(store.getState().portsJump, '8000')
  s.clearPortsJump()

  s.setActiveView('wsl')
  s.setWslBusyDistro('test-distro')
  s.jumpToDocker('images', 'nginx')
  s.jumpToPorts('8000')
  assert.equal(store.getState().activeView, 'wsl')
  assert.equal(store.getState().dockerJump, null)
  assert.equal(store.getState().portsJump, null)
  s.setWslBusyDistro(null)
})

test('a dev cache scan is not saved, and its folders and columns are', () => {
  const s = store.getState()
  s.setCacheRoots(['F:\\Scripts'])
  s.setCacheColumns({ widths: {}, hidden: ['type'] })
  s.setCacheScan({ items: [], skipped_roots: [], stopped: false })
  s.setCacheScanProgress({ folder: 'F:\\Scripts', found: 1 })
  const state = JSON.parse(savedNow()).state
  assert.deepEqual(state.cacheRoots, ['F:\\Scripts'])
  assert.deepEqual(state.cacheColumns.hidden, ['type'])
  assert.equal(state.cacheScan, undefined)
  assert.equal(state.cacheScanProgress, undefined)
  s.setCacheScan(null)
  s.setCacheScanProgress(null)
})

test('a failed clear can send the user to File locks already checking the folder', () => {
  const s = store.getState()
  s.jumpToLocks('F:\\Scripts\\app\\node_modules')
  assert.equal(store.getState().activeView, 'locks')
  assert.equal(store.getState().locksJump, 'F:\\Scripts\\app\\node_modules')
  s.clearLocksJump()
  assert.equal(store.getState().locksJump, null)
})

test('column choices are saved for each Docker table, and a jump is not', () => {
  const s = store.getState()
  s.setDockerColumns('images', { widths: { name: 300 }, hidden: ['id'] })
  assert.deepEqual(store.getState().dockerColumns.images, { widths: { name: 300 }, hidden: ['id'] })
  assert.deepEqual(store.getState().dockerColumns.volumes.hidden, ['project'], 'other tables keep theirs')
  s.jumpToDocker('images', 'nginx')
  const state = JSON.parse(savedNow()).state
  assert.deepEqual(state.dockerColumns.images.hidden, ['id'])
  assert.equal(state.dockerJump, undefined)
  s.clearDockerJump()
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
  store.getState().setActiveView('settings')
  const state = JSON.parse(savedNow()).state
  assert.equal(state.editorDrafts, undefined)
  assert.equal(persisted.includes('example-secret'), false)
})
