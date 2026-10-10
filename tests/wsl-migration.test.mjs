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

const errorSource = readFileSync(new URL('../src/utils/errors.ts', import.meta.url), 'utf8').replaceAll('\r\n', '\n').replace(/^import .*\n/gm, '')
const errorExports = {}
new Function('exports', ts.transpileModule(errorSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(errorExports)

function setup({ migrate = async () => migrated, reload = async () => {}, subscribe, initialBusy = null, currentPlan = plan, currentBlockers = [] } = {}) {
  const state = { busy: initialBusy, plan: currentPlan, error: null, result: null, phase: null, events: [] }
  const run = new Function(
    'move', 'api', 'useAppStore', 'plan', 'distro', 'setBusyDistro', 'setError', 'setPhase',
    'listen', 'setResult', 'onComplete', 'addActivity', 'toAppError', 'setPlan', 'onReload', 'blockers', 'listenForOutput', compileHandler('runMigrate'),
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
    value => { state.plan = value }, () => reload(state), currentBlockers,
    async () => { state.events.push('output-subscribed'); return () => state.events.push('output-unsubscribed') },
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
  assert.deepEqual(state.events, ['subscribed', 'output-subscribed', 'migrate', 'complete', 'success', 'unsubscribed', 'output-unsubscribed'])
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
  assert.deepEqual(state.events, ['subscribed', 'output-subscribed', 'migrate', 'failure', 'unsubscribed', 'output-unsubscribed'])
})

test('another operation or missing review prevents migration', async () => {
  for (const options of [{ initialBusy: 'Debian' }, { currentPlan: null }, { currentBlockers: [{ message: 'Update WSL' }] }]) {
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

function reviewSetup(preflight = async () => ({ plan, blockers: [], command_output: 'wsl --help: supported' })) {
  const state = { directory: 'F:\\', plan: null, error: null, blockers: [], output: '' }
  const review = new Function('check', 'directory', 'useAppStore', 'setError', 'api', 'distro', 'setDirectory', 'setPlan', 'toAppError', 'setBlockers', 'appendOutput', compileHandler('review'))(
    { run: callback => callback() }, state.directory, { getState: () => ({ wslBusyDistro: null }) },
    value => { state.error = value },
    {
      wslSuggestMigrationDir: async (name, path) => { assert.equal(name, 'Ubuntu'); assert.equal(path, 'F:\\'); return destination },
      wslPlanMigration: async (name, path) => { assert.equal(name, 'Ubuntu'); assert.equal(path, destination); assert.equal(state.directory, destination); return preflight(state) },
    },
    { name: 'Ubuntu' }, value => { state.directory = value }, value => { state.plan = value }, error => error,
    value => { state.blockers = value }, text => { state.output += text },
  )
  return { review, state }
}

test('review fills the suggested folder before checking prerequisites', async () => {
  const { review, state } = reviewSetup()
  await review()
  assert.equal(state.directory, destination)
  assert.equal(state.plan, plan)
  assert.match(state.output, /wsl --help/)
})

test('root suggestion survives a failed prerequisite check', async () => {
  const failure = { message: 'Could not query WSL', action: 'wsl-help' }
  const { review, state } = reviewSetup(async () => { throw failure })
  await review()
  assert.equal(state.directory, destination)
  assert.equal(state.error, failure)
  assert.equal(state.plan, null)
})

test('all detected blockers and Windows responses are retained together', async () => {
  const blockers = [{ action: 'update-wsl' }, { action: 'stop-docker' }]
  const { review, state } = reviewSetup(async () => ({ plan, blockers, command_output: 'Exit code: -1\nMissing --move' }))
  await review()
  assert.equal(state.plan, plan)
  assert.equal(state.blockers, blockers)
  assert.match(state.output, /Missing --move/)
})

test('the directory picker fills a recommended path without running preflight', async () => {
  const state = { directory: '', plan, error: new Error('Old error'), blockers: [{ action: 'update-wsl' }], focused: false }
  const pick = new Function('browse', 'api', 'distro', 'setDirectory', 'setError', 'setPlan', 'setBlockers', 'directoryRef', 'toAppError', compileHandler('pickFolder'))(
    { run: callback => callback() },
    { pickDirectory: async () => 'F:\\', wslSuggestMigrationDir: async (name, root) => { assert.equal(name, 'Ubuntu'); assert.equal(root, 'F:\\'); return destination } },
    { name: 'Ubuntu' }, value => { state.directory = value }, value => { state.error = value }, value => { state.plan = value },
    value => { state.blockers = value }, { current: { focus: () => { state.focused = true } } }, error => error,
  )
  await pick()
  assert.equal(state.directory, destination)
  assert.equal(state.plan, null)
  assert.equal(state.error, null)
  assert.deepEqual(state.blockers, [])
  assert.equal(state.focused, true)
})

test('command output is scoped to this distribution', async () => {
  const output = []
  const subscribe = new Function('listen', 'distro', 'appendOutput', compileHandler('listenForOutput'))(
    async (event, callback) => {
      assert.equal(event, 'wsl-migration-output')
      callback({ payload: { distro: 'Debian', text: 'Unrelated' } })
      callback({ payload: { distro: 'Ubuntu', text: 'Exit code: 0\nWindows response' } })
      return () => {}
    }, { name: 'Ubuntu' }, text => output.push(text),
  )
  await subscribe()
  assert.deepEqual(output, ['Exit code: 0\nWindows response'])
})

function repairSetup({ action = 'update-wsl', fix = async () => {}, initialBusy = null, previousError = null } = {}) {
  const state = { busy: initialBusy, error: previousError, plan, blockers: [{ action }], confirmation: action, events: [] }
  const run = new Function('repair', 'repairConfirmation', 'useAppStore', 'setBusyDistro', 'setError', 'listenForOutput', 'api', 'distro', 'toAppError', 'AppError', 'error', 'setPlan', 'setBlockers', 'onReload', 'setRepairConfirmation', 'review', compileHandler('runRepair'))(
    { run: callback => callback() }, action, { getState: () => ({ wslBusyDistro: state.busy }) },
    value => { state.busy = value }, value => { state.error = value },
    async () => { state.events.push('subscribed'); return () => state.events.push('unsubscribed') },
    { wslRepairMigration: async (name, chosen) => { assert.equal(name, 'Ubuntu'); assert.equal(chosen, action); assert.equal(state.busy, 'Ubuntu'); state.events.push('repair'); return fix(state) } },
    { name: 'Ubuntu' }, errorExports.toAppError, errorExports.AppError, previousError,
    value => { state.plan = value }, value => { state.blockers = value },
    async () => { assert.equal(state.busy, 'Ubuntu'); state.events.push('reload') },
    value => { state.confirmation = value }, async () => { assert.equal(state.busy, null); state.events.push('recheck') },
  )
  return { run, state }
}

test('a confirmed repair is followed by a recheck, never an automatic move', async () => {
  const { run, state } = repairSetup()
  await run()
  assert.equal(state.busy, null)
  assert.equal(state.confirmation, null)
  assert.deepEqual(state.events, ['subscribed', 'repair', 'unsubscribed', 'reload', 'recheck'])
})

test('a failed update exposes the Windows response and its web-download fallback', async () => {
  const { run, state } = repairSetup({ fix: async () => { throw { kind: 'network', message: 'The update failed.', detail: 'Microsoft Store unavailable', action: 'update-wsl-web' } } })
  await run()
  assert.equal(state.error.action, 'update-wsl-web')
  assert.equal(state.error.detail, 'Microsoft Store unavailable')
  assert.equal(state.plan, null)
  assert.deepEqual(state.blockers, [])
  assert.equal(state.busy, null)
  assert.ok(!state.events.includes('recheck'))
})

test('a failed shutdown repair preserves the original recovery guide', async () => {
  const previousError = new errorExports.AppError('busy', 'The disk is open.', undefined, undefined, migrated.recovery_path, 'stop-wsl')
  const { run, state } = repairSetup({ action: 'stop-wsl', previousError, fix: async () => { throw { kind: 'busy', message: 'Shutdown failed.', action: 'stop-wsl' } } })
  await run()
  assert.equal(state.error.recoveryPath, migrated.recovery_path)
  assert.equal(state.error.action, 'stop-wsl')
  assert.equal(state.busy, null)
})

test('an active operation prevents a repair from starting', async () => {
  const { run, state } = repairSetup({ initialBusy: 'Debian', fix: () => assert.fail('Must not repair') })
  await run()
  assert.equal(state.busy, 'Debian')
  assert.deepEqual(state.events, [])
})
