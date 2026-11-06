import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/features/packages/savedScan.ts', import.meta.url), 'utf8')
const saved = {}
new Function('exports', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(saved)

function fakeStorage(start = {}) {
  const values = new Map(Object.entries(start))
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }
}

const scan = { results: [{ id: 'npm', packages: [] }], scannedAt: 1000 }

test('a saved scan comes back unchanged', () => {
  const storage = fakeStorage()
  saved.saveScan(scan, storage)
  assert.deepEqual(saved.loadScan(storage), scan)
})

test('nothing saved, or anything unreadable, means no saved scan', () => {
  assert.equal(saved.loadScan(fakeStorage()), null)
  for (const junk of ['not json', 'null', '[]', '{"results":"x","scannedAt":1}', '{"results":[]}', '{"scannedAt":1}']) {
    assert.equal(saved.loadScan(fakeStorage({ 'workspace-atlas-packages-v1': junk })), null, junk)
  }
})

test('storage that refuses a read or a write does not throw', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  assert.equal(saved.loadScan(broken), null)
  assert.doesNotThrow(() => saved.saveScan(scan, broken))
})

test('a scan stays fresh for ten minutes', () => {
  const minutes = n => n * 60 * 1000
  assert.equal(saved.isFresh(minutes(100), minutes(100)), true)
  assert.equal(saved.isFresh(minutes(100), minutes(110) - 1), true)
  assert.equal(saved.isFresh(minutes(100), minutes(110)), false)
  assert.equal(saved.isFresh(0), false, 'never scanned')
})
