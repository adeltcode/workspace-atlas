import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/components/FileDropZone.tsx', import.meta.url), 'utf8')
const exports = {}
const shims = { '@tauri-apps/api/webview': {}, 'lucide-react': {}, clsx: {}, './ui': {} }
new Function('require', 'exports', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText)(name => shims[name] ?? require(name), exports)
const { readDrag } = exports

const position = { x: 10, y: 20 }
const paths = ['C:\\dev\\app']
const isInside = () => true
const isOutside = () => false

test('a drag counts as over the area only while it is on it', () => {
  assert.deepEqual(readDrag({ type: 'enter', paths, position }, isInside), { over: true, dropped: null })
  assert.deepEqual(readDrag({ type: 'enter', paths, position }, isOutside), { over: false, dropped: null })
  assert.deepEqual(readDrag({ type: 'over', position }, isInside), { over: true, dropped: null })
  assert.deepEqual(readDrag({ type: 'over', position }, isOutside), { over: false, dropped: null })
})

test('dragging away ends the hover and drops nothing', () => {
  assert.deepEqual(readDrag({ type: 'leave' }, isInside), { over: false, dropped: null })
})

test('a drop gives its paths only when it lands on the area', () => {
  assert.deepEqual(readDrag({ type: 'drop', paths, position }, isInside), { over: false, dropped: paths })
  assert.deepEqual(readDrag({ type: 'drop', paths, position }, isOutside), { over: false, dropped: null })
})

test('a drop with no paths is ignored', () => {
  assert.deepEqual(readDrag({ type: 'drop', paths: [], position }, isInside), { over: false, dropped: null })
})
