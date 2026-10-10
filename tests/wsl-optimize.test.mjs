import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('WslDistroPage.tsx', readFileSync(
  new URL('../src/features/wsl/components/WslDistroPage.tsx', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler
function findHandler(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'runOptimize') {
    handler = node.initializer.getText(source)
  }
  ts.forEachChild(node, findHandler)
}
findHandler(source)
assert.ok(handler, 'Disk optimization handler must exist')

const compiled = ts.transpileModule(`return (${handler});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

function setup(optimize, reload = async () => {}, initialBusy = null) {
  const state = { busy: initialBusy, operation: null, status: null, activities: [] }
  const run = new Function(
    'op', 'api', 'useAppStore', 'd', 'setConfirmOpt', 'setBusyOp', 'setBusyDistro',
    'setStatus', 'addActivity', 'bytesToHuman', 'onReload', 'toAppError', compiled,
  )(
    { run: callback => callback() },
    { wslOptimizeVhd: path => optimize(path, state) },
    { getState: () => ({ wslBusyDistro: state.busy }) },
    { name: 'Ubuntu', vhd_path: 'C:\\WSL\\ext4.vhdx' },
    () => {},
    value => { state.operation = value },
    value => { state.busy = value },
    value => { state.status = value },
    value => { state.activities.push(value) },
    value => `${value} bytes`,
    () => reload(state),
    error => error,
  )
  return { run, state }
}

test('optimization pauses probes through completion and the running-state refresh', async () => {
  let finishOptimize, finishReload
  const optimized = new Promise(resolve => { finishOptimize = resolve })
  const refreshed = new Promise(resolve => { finishReload = resolve })
  let reloadStarted
  const started = new Promise(resolve => { reloadStarted = resolve })
  const { run, state } = setup((path, current) => {
    assert.equal(path, 'C:\\WSL\\ext4.vhdx')
    assert.equal(current.busy, 'Ubuntu')
    return optimized
  }, current => {
    assert.equal(current.busy, 'Ubuntu')
    reloadStarted()
    return refreshed
  })
  const pending = run()
  assert.equal(state.busy, 'Ubuntu')
  assert.equal(state.operation, 'optimize')
  finishOptimize({ reclaimed_bytes: 5, before_bytes: 10, after_bytes: 5, method: 'diskpart' })
  await started
  assert.equal(state.busy, 'Ubuntu')
  finishReload()
  await pending
  assert.equal(state.busy, null)
  assert.equal(state.operation, null)
  assert.equal(state.status.kind, 'ok')
})

test('optimization preserves failure details and clears the busy state on cancellation', async () => {
  const error = {
    message: 'Administrator approval was not given.',
    hint: 'Approve the prompt.', detail: 'Windows error 1223',
  }
  let reloads = 0
  const { run, state } = setup(async () => { throw error }, current => {
    assert.equal(current.busy, 'Ubuntu')
    reloads++
  })
  await run()
  assert.equal(state.busy, null)
  assert.equal(state.operation, null)
  assert.equal(state.status.error, error)
  assert.match(state.activities[0].detail, /Windows error 1223/)
  assert.equal(reloads, 1)
})

test('another WSL operation prevents optimization from starting', async () => {
  const { run, state } = setup(() => assert.fail('Must not request elevation'), undefined, 'Other distro')
  await run()
  assert.equal(state.busy, 'Other distro')
  assert.equal(state.operation, null)
})

test('a failed running-state refresh still releases the busy state', async () => {
  const { run, state } = setup(async () => ({
    reclaimed_bytes: 0, before_bytes: 10, after_bytes: 10, method: 'Optimize-VHD',
  }), async () => { throw new Error('Refresh failed') })
  await assert.rejects(run(), /Refresh failed/)
  assert.equal(state.busy, null)
  assert.equal(state.operation, null)
})
