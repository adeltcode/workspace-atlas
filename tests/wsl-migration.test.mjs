import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = ts.createSourceFile('WslMigrationDialog.tsx', readFileSync(
  new URL('../src/features/wsl/components/WslMigrationDialog.tsx', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function compileHandler(name) {
  let handler
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) handler = node.initializer.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler, `${name} must exist`)
  return ts.transpileModule(`return (${handler});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
}

const destination = 'F:\\WSL\\Ubuntu'
const plan = { destination, create_directory: true, running_distros: ['Ubuntu', 'Debian'] }
const migrated = { destination, backup_path: 'F:\\WSL\\backup\\backup.vhdx', recovery_path: 'F:\\WSL\\backup\\RECOVERY.txt' }

function setup({ migrate = async () => migrated, reload = async () => {}, subscribe, initialBusy = null, currentPlan = plan } = {}) {
  const state = { busy: initialBusy, plan: currentPlan, error: null, result: null, phase: null, events: [] }
  const run = new Function(
    'move', 'api', 'useAppStore', 'plan', 'distro', 'setBusyDistro', 'setError', 'setPhase',
    'listen', 'setResult', 'onComplete', 'addActivity', 'toAppError', 'setPlan', 'onReload', compileHandler('runMigrate'),
  )(
    { run: callback => callback() },
    { wslMigrateDistro: async (name, path) => {
      assert.equal(name, 'Ubuntu'); assert.equal(path, destination)
      assert.equal(state.busy, 'Ubuntu')
      state.events.push('migrate')
      return migrate(state)
    } },
    { getState: () => ({ wslBusyDistro: state.busy }) },
    currentPlan, { name: 'Ubuntu' },
    value => { state.busy = value }, value => { state.error = value }, value => { state.phase = value },
    async (event, callback) => {
      assert.equal(event, 'wsl-migration-progress')
      await subscribe?.(callback, state)
      state.events.push('subscribed')
      return () => state.events.push('unsubscribed')
    },
    value => { state.result = value }, () => state.events.push('complete'),
    activity => state.events.push(activity.outcome), error => error,
    value => { state.plan = value }, () => reload(state),
  )
  return { run, state }
}

test('migration subscribes before execution and retains the busy guard through refresh', async () => {
  let finishReload, reloadStarted
  const refreshed = new Promise(resolve => { finishReload = resolve })
  const started = new Promise(resolve => { reloadStarted = resolve })
  const { run, state } = setup({
    subscribe: async callback => {
      callback({ payload: { distro: 'Ubuntu', phase: 'moving' } })
      callback({ payload: { distro: 'Debian', phase: 'checking' } })
    },
    reload: current => { assert.equal(current.busy, 'Ubuntu'); reloadStarted(); return refreshed },
  })
  const pending = run()
  await started
  assert.equal(state.busy, 'Ubuntu')
  assert.equal(state.phase, 'moving')
  assert.deepEqual(state.events, ['subscribed', 'migrate', 'complete', 'success', 'unsubscribed'])
  assert.equal(state.result, migrated)
  finishReload()
  await pending
  assert.equal(state.busy, null)
})

test('a failed move preserves recovery details and requires a fresh review', async () => {
  const failure = { message: 'Disk is locked.', recoveryPath: migrated.recovery_path, detail: 'Windows error 32' }
  const { run, state } = setup({ migrate: async () => { throw failure } })
  await run()
  assert.equal(state.error, failure)
  assert.equal(state.result, null)
  assert.equal(state.plan, null)
  assert.equal(state.busy, null)
  assert.deepEqual(state.events, ['subscribed', 'migrate', 'failure', 'unsubscribed'])
})

test('another operation or missing review prevents migration', async () => {
  for (const options of [{ initialBusy: 'Debian' }, { currentPlan: null }]) {
    const { run, state } = setup({ ...options, migrate: () => assert.fail('Must not migrate') })
    await run()
    assert.deepEqual(state.events, [])
    assert.equal(state.busy, options.initialBusy ?? null)
  }
})

test('a failed progress subscription never starts migration', async () => {
  const failure = new Error('Subscription failed')
  const { run, state } = setup({ subscribe: async () => { throw failure }, migrate: () => assert.fail('Must not migrate') })
  await run()
  assert.equal(state.error, failure)
  assert.equal(state.busy, null)
  assert.deepEqual(state.events, ['failure'])
})

test('a failed refresh still releases the guard and event listener', async () => {
  const { run, state } = setup({ reload: async () => { throw new Error('Refresh failed') } })
  await assert.rejects(run(), /Refresh failed/)
  assert.equal(state.busy, null)
  assert.ok(state.events.includes('unsubscribed'))
})

test('review uses the suggested path without starting migration', async () => {
  const state = { directory: 'F:\\', plan: null, error: null }
  const review = new Function('check', 'directory', 'useAppStore', 'setError', 'api', 'distro', 'setDirectory', 'setPlan', 'toAppError', compileHandler('review'))(
    { run: callback => callback() }, state.directory, { getState: () => ({ wslBusyDistro: null }) },
    value => { state.error = value },
    { wslPlanMigration: async (name, path) => { assert.equal(name, 'Ubuntu'); assert.equal(path, 'F:\\'); return plan } },
    { name: 'Ubuntu' }, value => { state.directory = value }, value => { state.plan = value }, error => error,
  )
  await review()
  assert.equal(state.directory, destination)
  assert.equal(state.plan, plan)
  assert.equal(state.error, null)
})
