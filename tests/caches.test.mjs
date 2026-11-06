import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = (path, shims = {}) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const exports = {}
  new Function('require', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(name => shims[name] ?? require(name), exports)
  return exports
}

const rules = compile('../src/features/caches/rules.ts', { '../../utils/format': compile('../src/utils/format.ts') })

const NOW = 1_800_000_000
const DAY = 86_400
const item = (name, more = {}) => ({
  kind: 'node-modules',
  name,
  paths: [`F:\\Scripts\\${name}\\node_modules`],
  size_bytes: 1000,
  file_count: 10,
  last_used: NOW,
  restore: 'npm install',
  note: null,
  ...more,
})
const names = rows => rows.map(r => r.name)

test('idle means not used for more than 30 days, and an unknown date is not idle', () => {
  assert.equal(rules.isIdle(item('a', { last_used: NOW - 31 * DAY }), NOW), true)
  assert.equal(rules.isIdle(item('a', { last_used: NOW - 29 * DAY }), NOW), false)
  assert.equal(rules.isIdle(item('a', { last_used: null }), NOW), false)
})

test('search, type, and idle filters narrow the list together', () => {
  const list = [
    item('shop'),
    item('old-shop', { last_used: NOW - 90 * DAY }),
    item('engine', { kind: 'rust-target', paths: ['F:\\Scripts\\engine\\target'] }),
    item('npm cache', { kind: 'shared', paths: ['C:\\Users\\me\\AppData\\Local\\npm-cache'] }),
  ]
  const found = (query = '', filter = 'all', kinds = []) => names(rules.filterItems(list, query, filter, kinds, NOW))
  assert.equal(found().length, 4)
  assert.deepEqual(found('', 'idle'), ['old-shop'])
  assert.deepEqual(found('', 'all', ['rust-target']), ['engine'])
  assert.deepEqual(found('', 'all', ['rust-target', 'shared']), ['engine', 'npm cache'])
  assert.deepEqual(found('SHOP'), ['shop', 'old-shop'])
  assert.deepEqual(found('rust build'), ['engine'], 'the type as it reads on screen')
  assert.deepEqual(found('appdata'), ['npm cache'], 'the location')
  assert.deepEqual(found('shop', 'idle'), ['old-shop'])
})

test('every column sorts, and unknown values stay last in both directions', () => {
  const list = [
    item('b', { size_bytes: 5, last_used: 200, restore: 'cargo build' }),
    item('a', { size_bytes: 9, last_used: null, restore: null }),
    item('c', { size_bytes: 1, last_used: 100, restore: 'npm install' }),
  ]
  const sorted = (key, dir) => names(rules.sortItems(list, key, dir))
  assert.deepEqual(sorted('size', 'desc'), ['a', 'b', 'c'])
  assert.deepEqual(sorted('size', 'asc'), ['c', 'b', 'a'])
  assert.deepEqual(sorted('used', 'desc'), ['b', 'c', 'a'])
  assert.deepEqual(sorted('used', 'asc'), ['c', 'b', 'a'])
  assert.deepEqual(sorted('restore', 'asc'), ['b', 'c', 'a'])
  assert.deepEqual(sorted('restore', 'desc'), ['c', 'b', 'a'])
  for (const key of ['name', 'type', 'files', 'location']) assert.equal(sorted(key, 'asc').length, 3, key)
  assert.deepEqual(names(list), ['b', 'a', 'c'], 'the list it was given stays as it was')
})

test('the shown command lists every folder and could be pasted into PowerShell', () => {
  const list = [
    item('a', { paths: ["F:\\it's here\\node_modules"] }),
    item('b', { paths: ['F:\\b\\x\\__pycache__', 'F:\\b\\y\\__pycache__'] }),
  ]
  assert.equal(
    rules.clearCommand(list),
    "Remove-Item -LiteralPath 'F:\\it''s here\\node_modules', 'F:\\b\\x\\__pycache__', 'F:\\b\\y\\__pycache__' -Recurse -Force",
  )
})

test('warnings are named, and the same one is not repeated', () => {
  assert.deepEqual(rules.clearNotes([item('a'), item('b', { note: 'Watch out.' }), item('b', { note: 'Watch out.' })]), ['b: Watch out.'])
})

test('a row leaves the list only when all of its folders are gone', () => {
  const scan = {
    items: [item('a'), item('b', { paths: ['F:\\b\\x', 'F:\\b\\y'] }), item('c')],
    skipped_roots: [],
    stopped: false,
  }
  const after = rules.afterClear(scan, ['F:\\Scripts\\a\\node_modules', 'F:\\b\\x'])
  assert.deepEqual(names(after.items), ['b', 'c'])
  assert.deepEqual(after.items[0].paths, ['F:\\b\\y'])
})

test('the result counts what was really cleared and what the drive really got back', () => {
  const list = [item('a'), item('b'), item('c', { paths: ['F:\\c\\x', 'F:\\c\\y'] })]
  const drives = [{ drive: 'F:', freed_bytes: 2_000_000_000, free_bytes: 9 }, { drive: 'C:', freed_bytes: 0, free_bytes: 9 }]
  assert.equal(
    rules.clearSummary(list, { removed: ['F:\\Scripts\\a\\node_modules', 'F:\\Scripts\\b\\node_modules', 'F:\\c\\x'], failed: [], drives }),
    'Cleared 2 caches. F: has 2.00 GB more free.',
  )
  assert.equal(rules.clearSummary([list[0]], { removed: [list[0].paths[0]], failed: [], drives: [] }), 'Cleared 1 cache.')
})

test('only a real command reads as a command', () => {
  assert.equal(rules.restoreIsCommand(item('a')), true)
  assert.equal(rules.restoreIsCommand(item('a', { kind: 'shared' })), false)
  assert.equal(rules.restoreIsCommand(item('a', { kind: 'python-bytecode' })), false)
})
