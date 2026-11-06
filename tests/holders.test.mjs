import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = (path, shims = {}) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const exports = {}
  new Function('require', 'exports', ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText)(name => shims[name] ?? require(name), exports)
  return exports
}

const rules = compile('../src/features/holders/rules.ts')
const format = compile('../src/utils/format.ts')

const proc = (name, pid, owner = 'app', distro = null, path = null) => ({ pid, name, path, started_at: 1, owner, distro })
const entry = (port, process, more = {}) => ({
  port,
  addresses: ['127.0.0.1'],
  reachable: 'this-pc',
  listening_since: null,
  source: process.distro ? 'wsl' : process.owner === 'docker' ? 'docker' : 'windows',
  details: { command: null, folder: null, memory_bytes: null, parent: null },
  process,
  ...more,
})
const entries = [
  entry(53, proc('System service', 0, 'distro-system', 'kali')),
  entry(135, proc('svchost.exe', 900, 'windows')),
  entry(903, proc('vmware-authd.exe', 950, 'admin')),
  entry(3000, proc('node.exe', 4100, 'app', null, 'C:\\node\\node.exe'), {
    listening_since: 500,
    details: { command: 'node vite.js', folder: 'C:\\dev\\shop', memory_bytes: 2000, parent: 'cmd.exe' },
  }),
  entry(5173, proc('node', 4200, 'wsl', 'kali'), {
    listening_since: 900,
    details: { command: 'node server.js', folder: '/home/me/api', memory_bytes: 9000, parent: 'bash' },
  }),
  entry(8081, proc('web-nginx', 0, 'docker'), { listening_since: 100, details: { command: 'nginx:alpine', folder: null, memory_bytes: null, parent: null } }),
  entry(49664, proc('Unknown program', 4400, 'unknown')),
]
const ports = (...args) => rules.filterPorts(entries, ...args).map(e => e.port)
const sorted = (key, dir) => rules.sortPorts(entries, key, dir).map(e => e.port)

test('a dropped item is named by the last part of its path', () => {
  assert.equal(rules.itemName('C:\\dev\\shop\\app.log'), 'app.log')
  assert.equal(rules.itemName('C:\\dev\\shop\\'), 'shop')
  assert.equal(rules.itemName('\\\\wsl.localhost\\kali\\home\\me\\api'), 'api')
  assert.equal(rules.itemName('C:\\'), 'C:')
})

test('the summary says what was checked, for one item or several', () => {
  const report = (path, is_folder) => ({ path, is_folder, complete: true, holders: [] })
  const adminNote = 'Processes running as administrator'
  assert.equal(rules.checkedSummary([report('C:\\a.log', false)]), 'Checked C:\\a.log.')
  const folder = rules.checkedSummary([report('C:\\dev', true)])
  assert.ok(folder.startsWith('Checked C:\\dev recursively.') && folder.includes(adminNote))
  assert.equal(rules.checkedSummary([report('C:\\a.log', false), report('C:\\b.log', false)]), 'Checked 2 items.')
  const mixed = rules.checkedSummary([report('C:\\a.log', false), report('C:\\dev', true)])
  assert.ok(mixed.startsWith('Checked 2 items, including folder contents.') && mixed.includes(adminNote))
})

test('the Programs filter hides system rows, and All keeps them', () => {
  assert.deepEqual(ports('', 'programs'), [903, 3000, 5173, 8081])
  assert.deepEqual(ports('', 'all'), [53, 135, 903, 3000, 5173, 8081, 49664])
})

test('search finds a port, a program, a PID, where it runs, its command, or its folder', () => {
  assert.deepEqual(ports('3000', 'programs'), [3000])
  assert.deepEqual(ports(':5173', 'programs'), [5173])
  assert.deepEqual(ports(' NODE ', 'programs'), [3000, 5173])
  assert.deepEqual(ports('4200', 'programs'), [5173])
  assert.deepEqual(ports('docker', 'programs'), [8081])
  assert.deepEqual(ports('kali', 'programs'), [5173])
  assert.deepEqual(ports('vite.js', 'programs'), [3000])
  assert.deepEqual(ports('dev\\shop', 'programs'), [3000])
  assert.deepEqual(ports('svchost', 'programs'), [])
  assert.deepEqual(ports('svchost', 'all'), [135])
  assert.deepEqual(ports('0', 'programs'), [], 'a container has no PID to match')
})

test('every column sorts, and unknown values stay last in both directions', () => {
  assert.deepEqual(sorted('port', 'desc'), [49664, 8081, 5173, 3000, 903, 135, 53])
  assert.deepEqual(sorted('since', 'asc').slice(0, 3), [8081, 3000, 5173])
  assert.deepEqual(sorted('since', 'desc').slice(0, 3), [5173, 3000, 8081])
  assert.deepEqual(sorted('since', 'desc').slice(3), [53, 135, 903, 49664], 'ties fall back to the port')
  assert.deepEqual(sorted('memory', 'desc').slice(0, 2), [5173, 3000])
  assert.deepEqual(sorted('memory', 'asc').slice(0, 2), [3000, 5173])
  assert.deepEqual(sorted('pid', 'asc').slice(0, 2), [135, 903])
  assert.deepEqual(sorted('pid', 'asc').slice(-2), [53, 8081], 'a container or nameless service has no PID')
  assert.equal(sorted('command', 'asc')[0], 8081)
  for (const key of ['program', 'runs-in', 'reachable', 'folder', 'parent', 'address', 'path']) {
    assert.equal(rules.sortPorts(entries, key, 'asc').length, entries.length, key)
  }
})

test('sorting leaves the list it was given alone', () => {
  const before = entries.map(e => e.port)
  rules.sortPorts(entries, 'port', 'desc')
  assert.deepEqual(entries.map(e => e.port), before)
})

test('where a port runs reads plainly', () => {
  assert.equal(rules.runsIn(entries[3]), 'Windows')
  assert.equal(rules.runsIn(entries[4]), 'WSL: kali')
  assert.equal(rules.runsIn(entries[5]), 'Docker')
})

test('the time says what it measures, and an unknown time has no explanation', () => {
  assert.doesNotMatch(rules.sinceTitle(entries[3]), /started/)
  assert.match(rules.sinceTitle(entries[4]), /when the program started/)
  assert.match(rules.sinceTitle(entries[5]), /when the container started/)
  assert.equal(rules.sinceTitle(entries[0]), undefined)
})

test('only programs we can really close get a Close button', () => {
  assert.equal(rules.canClose(proc('node.exe', 1)), true)
  assert.equal(rules.canClose(proc('node', 1, 'wsl', 'kali')), true)
  assert.equal(rules.canClose(proc('wslrelay.exe', 1, 'wsl')), false, 'Windows side of WSL')
  for (const owner of ['admin', 'docker', 'distro-system', 'windows', 'this-app', 'unknown']) {
    assert.equal(rules.canClose(proc('x', 1, owner)), false, owner)
  }
  for (const owner of ['admin', 'distro-system', 'windows', 'this-app', 'unknown']) assert.ok(rules.NOT_CLOSABLE[owner], owner)
})

test('the shown command is what a person could type', () => {
  assert.equal(rules.closeCommand(proc('node.exe', 4100)), 'taskkill /PID 4100 /F')
  assert.equal(rules.closeCommand(proc('node', 4200, 'wsl', 'kali')), 'wsl -d kali -u root kill 4200')
  assert.equal(rules.closeCommand(proc('web-nginx', 0, 'docker')), 'docker stop web-nginx')
  assert.equal(rules.closeCommand(proc('com.docker.backend.exe', 900, 'docker')), 'docker desktop stop')
  assert.equal(rules.closeCommand(proc('wslrelay.exe', 900, 'wsl')), 'wsl --shutdown')
})

test('every holder gets the fix that really frees what it holds', () => {
  assert.equal(rules.fixFor(proc('node.exe', 1)), 'close')
  assert.equal(rules.fixFor(proc('node', 1, 'wsl', 'kali')), 'close')
  assert.equal(rules.fixFor(proc('web-nginx', 0, 'docker')), 'stop-container', 'a container has PID 0')
  assert.equal(rules.fixFor(proc('com.docker.backend.exe', 900, 'docker')), 'stop-docker')
  assert.equal(rules.fixFor(proc('wslrelay.exe', 900, 'wsl')), 'stop-wsl')
  for (const owner of ['admin', 'distro-system', 'windows', 'this-app', 'unknown']) {
    assert.equal(rules.fixFor(proc('x', 1, owner)), null, owner)
    assert.ok(rules.NOT_CLOSABLE[owner], owner)
  }
})

test('the dialog and the result say what happens to that kind of holder', () => {
  const container = proc('web-nginx', 0, 'docker')
  assert.equal(rules.fixDialog(container).title, 'Stop web-nginx?')
  assert.match(rules.fixDialog(container).consequence, /can be restarted/)
  assert.equal(rules.fixDone(container), 'Stopped web-nginx')

  const desktop = proc('com.docker.backend.exe', 900, 'docker')
  assert.match(rules.fixDialog(desktop).consequence, /stops all running containers/)
  assert.equal(rules.fixDone(desktop), 'Stopped Docker Desktop')

  const relay = proc('wslrelay.exe', 900, 'wsl')
  assert.match(rules.fixDialog(relay).consequence, /stops all running distros/)
  assert.equal(rules.fixDone(relay), 'Shut down WSL')

  assert.match(rules.fixDialog(proc('node', 1, 'wsl', 'kali')).consequence, /in kali/)
  assert.equal(rules.fixDone(proc('node.exe', 1)), 'Closed node.exe')
})

test('a file-in-use error offers the File locks page, and other errors do not', () => {
  const Stub = () => null
  const ui = compile('../src/components/ui.tsx', {
    './CommandOutput': { __esModule: true, default: Stub },
    './ModalShell': { __esModule: true, default: ({ children }) => children },
    '../store/appStore': { useAppStore: { getState: () => ({ setActiveView() {} }) } },
    '../utils/errors': { toAppError: e => e },
    '../utils/format': format,
  })
  const render = (kind, message = 'Failed') => renderToStaticMarkup(createElement(ui.ErrorBanner, { error: { kind, message } }))
  assert.match(render('busy'), /Open File locks/)
  assert.doesNotMatch(render('permission'), /Open File locks/)
  assert.match(render('unknown', 'Bind for 0.0.0.0:8000 failed: port is already allocated'), /View port 8000 in Ports/)
  assert.doesNotMatch(render('unknown'), /in Ports/)
  const named = renderToStaticMarkup(createElement(ui.ErrorBanner, { error: { kind: 'busy', message: 'Failed' }, lockedPath: 'C:\\x' }))
  assert.match(named, /View in File locks/)
  assert.doesNotMatch(named, /Open File locks/, 'one way out, not two')
})

test('an error about a taken port names the port, however it is worded', () => {
  assert.equal(format.portInUse('Bind for 0.0.0.0:8000 failed: port is already allocated'), 8000)
  assert.equal(format.portInUse('listen tcp 127.0.0.1:5432: bind: address already in use'), 5432)
  assert.equal(format.portInUse('ports are not available: exposing port TCP 0.0.0.0:3000 -> 127.0.0.1:0: listen tcp 0.0.0.0:3000: bind: Only one usage of each socket address'), 3000)
  assert.equal(format.portInUse('listen tcp [::]:9000: bind: address already in use'), 9000)
  assert.equal(format.portInUse('container 0.0.0.0:80 is not running'), null, 'mentions a port, but not a taken one')
  assert.equal(format.portInUse('address already in use'), null, 'no port named')
})
