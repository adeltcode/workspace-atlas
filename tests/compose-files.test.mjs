import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('ComposeTab.tsx', readFileSync(
  new URL('../src/features/docker/components/ComposeTab.tsx', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

const handlers = {}
function find(node) {
  if (ts.isVariableDeclaration(node) && ['loadFile', 'loadExtraFile'].includes(node.name.getText(source))) {
    handlers[node.name.getText(source)] = ts.transpileModule(`return (${node.initializer.getText(source)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
  }
  ts.forEachChild(node, find)
}
find(source)

function deferred() {
  let resolve, reject
  const promise = new Promise((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const reads = {}
  const state = { content: null, contents: {}, error: null, loading: false }
  const scope = {
    api: { readFileContent: path => (reads[path] = deferred()).promise },
    fileRequest: { current: 0 },
    setFileLoading: v => { state.loading = v },
    setFileError: v => { state.error = v },
    setFileContent: v => { state.content = v },
    setFileContents: update => { state.contents = update(state.contents) },
  }
  const build = body => new Function(...Object.keys(scope), 'fileContents', body)
  const loadFile = build(handlers.loadFile)(...Object.values(scope), {})
  const loadExtraFile = path => build(handlers.loadExtraFile)(...Object.values(scope), state.contents)(path)
  return { reads, state, loadFile, loadExtraFile }
}

test('a slow read of the old file does not appear under the new one', async () => {
  const { reads, state, loadFile } = setup()
  const first = loadFile('a/compose.yml')
  const second = loadFile('b/compose.yml')

  reads['b/compose.yml'].resolve('B')
  await second
  reads['a/compose.yml'].resolve('A')
  await first

  assert.equal(state.content, 'B')
  assert.equal(state.loading, false)
})

test('a slow failure of the old file does not show an error on the new one', async () => {
  const { reads, state, loadFile } = setup()
  const first = loadFile('a/compose.yml')
  const second = loadFile('b/compose.yml')

  reads['b/compose.yml'].resolve('B')
  await second
  reads['a/compose.yml'].reject('no such file')
  await first

  assert.equal(state.content, 'B')
  assert.equal(state.error, null)
})

test('the newest failed read shows its error', async () => {
  const { reads, state, loadFile } = setup()
  const read = loadFile('a/compose.yml')
  reads['a/compose.yml'].reject('Access is denied')
  await read

  assert.equal(state.content, null)
  assert.equal(state.error, 'Access is denied')
  assert.equal(state.loading, false)
})

test('a file that cannot be read never counts as an empty file', async () => {
  const { reads, state, loadExtraFile } = setup()
  const read = loadExtraFile('a/Dockerfile')
  reads['a/Dockerfile'].reject('Access is denied')
  await read

  assert.equal(state.contents['a/Dockerfile'], undefined, 'the Edit button stays off while this is undefined')
  assert.equal(state.error, 'Access is denied')
})

test('opening a file clears the error from the last one, and a loaded file is not read again', async () => {
  const { reads, state, loadExtraFile } = setup()
  const failed = loadExtraFile('a/Dockerfile')
  reads['a/Dockerfile'].reject('Access is denied')
  await failed

  const ok = loadExtraFile('b/Dockerfile')
  assert.equal(state.error, null)
  reads['b/Dockerfile'].resolve('FROM alpine')
  await ok
  assert.equal(state.contents['b/Dockerfile'], 'FROM alpine')

  delete reads['b/Dockerfile']
  await loadExtraFile('b/Dockerfile')
  assert.equal(reads['b/Dockerfile'], undefined)
})
