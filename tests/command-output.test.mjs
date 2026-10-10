import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/components/CommandOutput.tsx', import.meta.url), 'utf8')
const output = {}
new Function('require', 'exports', ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText)(name => name === './ModalShell' ? { default: () => null } : require(name), output)

test('highlighting preserves the exact output, indentation, line breaks, and long paths', () => {
  const text = `$ wsl --export 'workstation-kali' 'F:\\${'long-folder\\'.repeat(100)}backup.vhdx' --vhd\r\n\tstdout:\r\n\r\nExit code: 0\n`
  const html = renderToStaticMarkup(createElement(output.OutputText, { text }))
  const restored = html.replace(/<\/?span[^>]*>/g, '')
    .replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  assert.equal(restored, text)
  assert.ok(html.includes('output-command'))
  assert.ok(html.includes('output-flag'))
  assert.ok(html.includes('output-string'))
  assert.ok(html.includes('output-success'))
})

test('untrusted output stays escaped and failed exit codes remain visibly distinct', () => {
  const text = '<script>alert("unsafe")</script> & <img src=x onerror=alert(1)>\nExit code: -1\nF:\\WSL\\disk.vhdx'
  const html = renderToStaticMarkup(createElement(output.OutputText, { text }))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('<img '))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('output-error'))
  assert.ok(html.includes('output-path'))
})

test('ordinary hyphenated prose and web addresses are not mistaken for command flags or disk paths', () => {
  const text = 'A fixed-size disk is passed as-is. See https://aka.ms/privacy.'
  const html = renderToStaticMarkup(createElement(output.OutputText, { text }))
  assert.ok(!html.includes('output-flag'))
  assert.ok(!html.includes('output-path'))
})
