import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

function load(path) {
  const url = new URL(path, import.meta.url)
  const exports = {}
  new Function('require', 'exports', ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(createRequire(url), exports)
  return exports
}

const { delayedStorage, capLines, capDetail } = load('../src/store/savedState.ts')
const { skipWhileRunning } = load('../src/hooks/useVisiblePoll.ts')

function fakeStorage(start = {}) {
  const values = new Map(Object.entries(start))
  const writes = []
  return {
    writes,
    getItem: k => values.get(k) ?? null,
    setItem(k, v) { values.set(k, v); writes.push(v) },
    removeItem(k) { values.delete(k) },
  }
}

const value = n => ({ state: { n }, version: 0 })

test('many changes in a row are written once, with the newest state', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const disk = fakeStorage()
  const saved = delayedStorage(disk, 300)
  for (let n = 0; n < 50; n++) saved.setItem('key', value(n))
  assert.equal(disk.writes.length, 0)
  t.mock.timers.tick(300)
  assert.deepEqual(disk.writes.map(w => JSON.parse(w).state.n), [49])
})

test('steady changes still get written, because the wait does not restart', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const disk = fakeStorage()
  const saved = delayedStorage(disk, 300)
  for (let n = 0; n < 10; n++) {
    saved.setItem('key', value(n))
    t.mock.timers.tick(100)
  }
  assert.ok(disk.writes.length >= 3, `${disk.writes.length} writes`)
})

test('a change to something that is not saved writes nothing', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const disk = fakeStorage()
  const saved = delayedStorage(disk, 300)
  saved.setItem('key', value(1))
  t.mock.timers.tick(300)
  saved.setItem('key', value(1))
  t.mock.timers.tick(300)
  assert.equal(disk.writes.length, 1)
})

test('flush writes what is waiting right away, once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const disk = fakeStorage()
  const saved = delayedStorage(disk, 300)
  saved.flush()
  assert.equal(disk.writes.length, 0, 'nothing waiting')
  saved.setItem('key', value(1))
  saved.flush()
  assert.equal(disk.writes.length, 1)
  t.mock.timers.tick(300)
  assert.equal(disk.writes.length, 1)
})

test('an import is not overwritten by an older write that was waiting', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const disk = fakeStorage()
  const saved = delayedStorage(disk, 300)
  saved.setItem('key', value('old'))
  disk.setItem('key', JSON.stringify(value('imported')))
  assert.equal(saved.getItem('key').state.n, 'imported')
  t.mock.timers.tick(300)
  assert.equal(JSON.parse(disk.getItem('key')).state.n, 'imported')
})

test('nothing saved reads as nothing', () => {
  assert.equal(delayedStorage(fakeStorage()).getItem('key'), null)
})

test('a long log keeps its newest lines and says it was cut', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`)
  const capped = capLines(lines)
  assert.equal(capped.length, 501)
  assert.match(capped[0], /trimmed/i)
  assert.equal(capped.at(-1), 'line 1999')
  assert.deepEqual(capLines(['a', 'b']), ['a', 'b'])
})

test('a long detail is cut, and a short or missing one is left alone', () => {
  assert.equal(capDetail(undefined), undefined)
  assert.equal(capDetail('short'), 'short')
  const long = capDetail('x'.repeat(10000))
  assert.ok(long.length <= 4001)
  assert.ok(long.endsWith('…'))
})

test('a slow poll is skipped until the last one finishes', async () => {
  let finish
  let calls = 0
  const tick = skipWhileRunning(() => { calls++; return new Promise(r => { finish = r }) })
  tick(); tick(); tick()
  assert.equal(calls, 1)
  finish()
  await new Promise(r => setTimeout(r))
  tick()
  assert.equal(calls, 2)
})

test('a poll that fails, or throws, does not block the next one', async () => {
  let calls = 0
  const rejects = skipWhileRunning(() => { calls++; return Promise.reject(new Error('down')) })
  rejects()
  await new Promise(r => setTimeout(r))
  rejects()
  assert.equal(calls, 2)

  let thrown = 0
  const throws = skipWhileRunning(() => { thrown++; throw new Error('bug') })
  throws()
  await new Promise(r => setTimeout(r))
  throws()
  assert.equal(thrown, 2)
})
