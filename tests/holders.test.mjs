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

const proc = (name, pid, owner = 'app', distro = null) => ({ pid, name, path: null, started_at: 1, owner, distro })
const entry = (port, process) => ({ port, addresses: ['127.0.0.1'], reachable: 'this-pc', process })
const entries = [
  entry(53, proc('System service', 0, 'distro-system', 'kali')),
  entry(135, proc('svchost.exe', 900, 'windows')),
  entry(903, proc('vmware-authd.exe', 950, 'admin')),
  entry(3000, proc('node.exe', 4100)),
  entry(5173, proc('node', 4200, 'wsl', 'kali')),
  entry(8081, { ...proc('web-nginx', 0, 'docker'), path: 'Docker container' }),
  entry(49664, proc('Unknown program', 4400, 'unknown')),
]
const ports = (...args) => rules.filterPorts(entries, ...args).map(e => e.port)

test('the Programs filter hides system rows, and All keeps them', () => {
  assert.deepEqual(ports('', 'programs'), [903, 3000, 5173, 8081])
  assert.deepEqual(ports('', 'all'), [53, 135, 903, 3000, 5173, 8081, 49664])
})

test('search finds a port, a program, a PID, or where it runs', () => {
  assert.deepEqual(ports('3000', 'programs'), [3000])
  assert.deepEqual(ports(':5173', 'programs'), [5173])
  assert.deepEqual(ports(' NODE ', 'programs'), [3000, 5173])
  assert.deepEqual(ports('4200', 'programs'), [5173])
  assert.deepEqual(ports('docker', 'programs'), [8081])
  assert.deepEqual(ports('svchost', 'programs'), [])
  assert.deepEqual(ports('svchost', 'all'), [135])
  assert.deepEqual(ports('0', 'programs'), [], 'a container has no PID to match')
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
})

test('a file-in-use error offers the File locks page, and other errors do not', () => {
  const Stub = () => null
  const ui = compile('../src/components/ui.tsx', {
    './CommandOutput': { __esModule: true, default: Stub },
    './ModalShell': { __esModule: true, default: ({ children }) => children },
    '../store/appStore': { useAppStore: { getState: () => ({ setActiveView() {} }) } },
    '../utils/errors': { toAppError: e => e },
  })
  const render = kind => renderToStaticMarkup(createElement(ui.ErrorBanner, { error: { kind, message: 'Failed' } }))
  assert.match(render('busy'), /See what holds it/)
  assert.doesNotMatch(render('permission'), /See what holds it/)
})
