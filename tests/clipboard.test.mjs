import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const nodeRequire = createRequire(import.meta.url)
const compile = (url, require) => {
  const exports = {}
  new Function('require', 'exports', ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(require, exports)
  return exports
}
const sortRows = compile(new URL('../src/utils/sortRows.ts', import.meta.url))
const rules = compile(new URL('../src/features/clipboard/rules.ts', import.meta.url),
  name => (name === '../../utils/sortRows' ? sortRows : nodeRequire(name)))

const item = (text, more = {}) => ({
  id: text ?? 'none',
  copied_at: 1000,
  formats: text === null ? [] : ['Text'],
  text,
  text_length: text === null ? null : text.length,
  has_image: false,
  has_html: false,
  has_files: false,
  ...more,
})

const status = (more = {}) => ({
  history_on: true,
  user_setting: true,
  blocked_by_policy: false,
  block_is_managed: false,
  sync_on: false,
  service_disabled: false,
  service_stopped: false,
  win_v_disabled: false,
  held_by: null,
  other_programs: [],
  ...more,
})

const program = (name, pid = 40) => ({ pid, name, path: null, started_at: 1, owner: 'app', distro: null })

test('items are sorted into types from what they hold', () => {
  const kinds = [
    ['https://example.com/a?b=1', 'link'],
    ['C:\\dev\\shop\\main.rs', 'path'],
    ['\\\\server\\share\\file.txt', 'path'],
    ['#4c53c4', 'color'],
    ['rgb(1, 2, 3)', 'color'],
    ['dev@example.com', 'email'],
    ['{"a": 1}', 'json'],
    ['[1, 2]', 'json'],
    ['{not json', 'text'],
    ['just some words', 'text'],
    ['see https://example.com for more', 'text'],
  ]
  for (const [text, kind] of kinds) assert.equal(rules.kindOf(item(text)), kind, text)
  assert.equal(rules.kindOf(item(null, { has_image: true })), 'image')
  assert.equal(rules.kindOf(item(null, { has_files: true })), 'files')
  assert.equal(rules.kindOf(item(null, { has_html: true })), 'html')
  assert.equal(rules.kindOf(item(null)), 'other')
})

test('text that looks like a secret is flagged, and ordinary text is not', () => {
  // Built from pieces, so secret scanners do not read these fake values as real ones.
  const secrets = [
    '-----BEGIN RSA ' + 'PRIVATE KEY-----',
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'ghp_' + 'x'.repeat(36),
    'sk-' + 'abcdefghijklmnopqrstuvwx',
    'password: hunter2',
    'API_KEY=abc123',
    'Authorization: Bearer ' + 'abcdefghijklmnop1234',
    'postgres://admin:hunter2@localhost/db',
    'eyJhbGciOiJIUzI1.' + 'eyJzdWIiOiIxMjM0.' + 'abcdefghijklmnop',
    'Xk9#mP2$vL7qR4wZ',
  ]
  for (const text of secrets) assert.equal(rules.looksSecret(item(text)), true, text)

  const ordinary = [
    'just some words',
    'password',
    'https://example.com/path/ToSomething123',
    'C:\\Users\\Dev\\Projects\\MyApp2\\main.rs',
    '550e8400-e29b-41d4-a716-446655440000',
    'getElementById',
    'npm install --save-dev typescript',
  ]
  for (const text of ordinary) assert.equal(rules.looksSecret(item(text)), false, text)
  assert.equal(rules.looksSecret(item(null, { has_image: true })), false)
})

test('filters and search find the right items', () => {
  const items = [
    item('plain words'),
    item('https://example.com'),
    item(null, { id: 'picture', has_image: true }),
    item('password=hunter2'),
    item(null, { id: 'formatted', has_html: true }),
  ]
  const ids = (filter, query = '') => rules.filterItems(items, query, filter).map(i => i.id)
  assert.equal(ids('all').length, 5)
  assert.deepEqual(ids('text'), ['plain words', 'password=hunter2', 'formatted'])
  assert.deepEqual(ids('image'), ['picture'])
  assert.deepEqual(ids('link'), ['https://example.com'])
  assert.deepEqual(ids('secret'), ['password=hunter2'])
  assert.deepEqual(ids('all', 'WORDS'), ['plain words'])
  assert.deepEqual(ids('all', 'image'), ['picture'])
  assert.deepEqual(ids('link', 'words'), [])
})

test('sorting keeps unknown values last and ties newest first', () => {
  const a = item('b text', { id: 'a', copied_at: 1 })
  const b = item('a text', { id: 'b', copied_at: 2 })
  const c = item(null, { id: 'c', copied_at: 3, has_image: true })
  const ids = (key, dir) => rules.sortItems([a, b, c], key, dir).map(i => i.id)
  assert.deepEqual(ids('copied', 'desc'), ['c', 'b', 'a'])
  assert.deepEqual(ids('copied', 'asc'), ['a', 'b', 'c'])
  assert.deepEqual(ids('content', 'asc'), ['b', 'a', 'c'])
  assert.deepEqual(ids('content', 'desc'), ['a', 'b', 'c'])
  assert.deepEqual(ids('size', 'desc'), ['b', 'a', 'c'])
})

test('known items keep their content when the backend leaves it out', () => {
  const known = [item('old', { id: 'old' })]
  const merged = rules.mergeEntries([
    { id: 'new', copied_at: 5, content: { ...item('new'), id: undefined, copied_at: undefined } },
    { id: 'old', copied_at: 1000, content: null },
    { id: 'gone', copied_at: 1, content: null },
  ], known)
  assert.deepEqual(merged.map(i => i.id), ['new', 'old'])
  assert.equal(merged[0].copied_at, 5)
  assert.equal(merged[1].text, 'old')
})

test('plain text is offered only when it differs and nothing was cut off', () => {
  assert.equal(rules.canCopyAsPlainText(item('words')), false)
  assert.equal(rules.canCopyAsPlainText(item('words', { has_html: true })), true)
  assert.equal(rules.canCopyAsPlainText(item('words', { formats: ['Text', 'Rich Text Format'] })), true)
  assert.equal(rules.canCopyAsPlainText(item('words', { has_html: true, text_length: 500000 })), false)
  assert.equal(rules.canCopyAsPlainText(item(null, { has_html: true })), false)
})

test('text details count what is there', () => {
  assert.deepEqual(rules.textStats('one two\nthree'), { characters: 13, words: 3, lines: 2 })
  assert.deepEqual(rules.textStats(''), { characters: 0, words: 0, lines: 0 })
  assert.equal(rules.previewLine('a\n\n  b\tc'), 'a b c')
  assert.equal(rules.sizeLabel(item('a')), '1 character')
  assert.equal(rules.sizeLabel(item(null)), null)
  assert.equal(rules.formatJson('{"a":1}'), '{\n  "a": 1\n}')
  assert.equal(rules.formatJson('not json'), null)
})

test('the history state follows the service first, then history, then the policy', () => {
  assert.equal(rules.historyState(status()), 'on')
  assert.equal(rules.historyState(status({ history_on: false, user_setting: false })), 'off')
  assert.equal(rules.historyState(status({ history_on: false, user_setting: null })), 'off')
  assert.equal(rules.historyState(status({ history_on: false, user_setting: false, blocked_by_policy: true })), 'blocked')
  assert.equal(rules.historyState(status({ history_on: false, user_setting: true })), 'not-applied')
  assert.equal(rules.historyState(status({ history_on: false, service_stopped: true, blocked_by_policy: true })), 'service-off')
  assert.equal(rules.historyState(status({ blocked_by_policy: true })), 'on')
})

test('a problem says why history is not running, and only offers a fix that can work', () => {
  const problem = more => rules.problemFor(status({ history_on: false, ...more }))
  const actions = more => problem(more).actions

  assert.equal(rules.problemFor(status()), null)
  assert.deepEqual(actions({ user_setting: false }), ['turn-on'])
  assert.deepEqual(actions({ blocked_by_policy: true }), ['remove-block', 'open-settings'])
  assert.deepEqual(actions({ blocked_by_policy: true, block_is_managed: true }), ['open-settings'])
  assert.match(problem({ blocked_by_policy: true, block_is_managed: true }).title, /device management/)
  assert.deepEqual(actions({ user_setting: true }), ['try-again', 'restart-service'])
  assert.deepEqual(actions({ service_disabled: true, service_stopped: true }), ['enable-service'])
  assert.deepEqual(actions({ service_stopped: true }), [])
  assert.match(problem({ service_stopped: true }).title, /Sign out/)
})

test('notices do not repeat the problem, and only warnings stay on the page', () => {
  const keys = more => rules.noticesFor(status(more)).map(n => n.key)
  const only = more => rules.noticesFor(status(more))[0]

  assert.deepEqual(keys({}), [])
  assert.deepEqual(keys({ history_on: false, blocked_by_policy: true }), [])
  assert.deepEqual(keys({ history_on: false, user_setting: true }), [])
  assert.deepEqual(keys({ history_on: false, service_disabled: true, service_stopped: true }), [])
  assert.deepEqual(keys({ history_on: false, service_stopped: true }), [])

  assert.equal(only({ blocked_by_policy: true }).key, 'blocked-later')
  assert.equal(only({ service_disabled: true }).action, 'enable-service')
  assert.equal(only({ sync_on: true }).action, 'open-settings')
  assert.equal(only({ win_v_disabled: true }).tone, 'info')

  const held = only({ held_by: program('stuck.exe') })
  assert.match(held.title, /stuck\.exe/)
  assert.equal(held.tone, 'warn')
  assert.equal(held.program.pid, 40)
})

test('another clipboard program is explained for the state history is in', () => {
  const ditto = { label: 'Ditto', kind: 'keeps-history', process: program('Ditto.exe') }
  const paste = { label: 'PowerToys Advanced Paste', kind: 'uses-windows-history', process: program('PowerToys.AdvancedPaste.exe', 41) }
  const rdp = { label: 'Remote Desktop', kind: 'shares-clipboard', process: program('rdpclip.exe', 42) }
  const vault = { label: 'KeePassXC', kind: 'clears-clipboard', process: program('KeePassXC.exe', 43) }

  const on = rules.noticesFor(status({ other_programs: [ditto, paste, rdp, vault] }))
  assert.match(on[0].detail, /saved twice/)
  assert.equal(on[0].tone, 'info')
  assert.equal(on[0].program.pid, 40, 'a program with its own history can be closed from here')
  assert.equal(on[1].tone, 'info')
  assert.equal(on[1].program, undefined)
  assert.match(on[2].detail, /another device/)
  assert.match(on[3].detail, /clear the clipboard/)

  const off = rules.noticesFor(status({ history_on: false, user_setting: false, other_programs: [ditto, paste] }))
  assert.match(off[0].detail, /even while Windows history is off/)
  assert.match(off[1].detail, /empty while history is off/)
})

test('the setting command works for both directions', () => {
  assert.equal(rules.historyCommand(true), 'reg add HKCU\\Software\\Microsoft\\Clipboard /v EnableClipboardHistory /t REG_DWORD /d 1 /f')
  assert.match(rules.historyCommand(false), /\/d 0 \/f$/)
})
