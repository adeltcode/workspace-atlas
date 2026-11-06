import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const compile = (url, require) => {
  const exports = {}
  new Function('require', 'exports', ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(require, exports)
  return exports
}
const sortRows = compile(new URL('../src/utils/sortRows.ts', import.meta.url))
const rules = compile(new URL('../src/features/docker/rules.ts', import.meta.url), () => sortRows)

const container = (name, more = {}) => ({
  id: `${name}-id`, name, image: 'nginx:alpine', state: 'running', status: 'Up 2 days', ports: '',
  created_since: '2 days ago', stopped_days: -1, compose_project: null, compose_service: null, ...more,
})
const image = (repository, tag, more = {}) => ({
  id: `sha256:${repository}${tag}`, repository, tag, size: '10MB', size_bytes: 10, created_since: '2 days ago', age_days: 2, in_use: false, ...more,
})
const volume = (name, more = {}) => ({ name, driver: 'local', in_use: false, containers: [], compose_project: null, size_bytes: 0, ...more })
const network = (name, more = {}) => ({ id: `${name}-id`, name, driver: 'bridge', scope: 'local', internal: false, ipv6: false, created: '', ...more })
const names = rows => rows.map(r => r.name)

test('every column key that sorts is handled, and every table can name its columns', () => {
  const tables = {
    containers: [rules.sortContainers, container('a')],
    images: [rules.sortImages, image('a', '1')],
    volumes: [rules.sortVolumes, volume('a')],
    networks: [rules.sortNetworks, network('a')],
  }
  for (const [tab, [sort, row]] of Object.entries(tables)) {
    const columns = rules.DOCKER_COLUMNS[tab]
    assert.equal(columns.find(c => c.key === 'name').hideable, undefined, `${tab} always shows its name`)
    assert.equal(columns.find(c => c.key === 'actions').hideable, undefined, `${tab} always shows its actions`)
    assert.ok(columns.filter(c => c.hideable).length > 0, `${tab} has columns to choose`)
    for (const { sort: key } of columns) if (key) assert.equal(sort([row], key, 'asc').length, 1, `${tab} ${key}`)
  }
})

test('published ports are read, including ranges, and the same port on IPv6 counts once', () => {
  assert.deepEqual(rules.parsePorts(''), [])
  assert.deepEqual(rules.parsePorts('9000/tcp'), [], 'not published')
  assert.deepEqual(rules.parsePorts('0.0.0.0:80->8080/tcp, [::]:80->8080/tcp'), [{ host: '80', container: '8080', proto: 'tcp' }])
  assert.deepEqual(rules.parsePorts('0.0.0.0:8000-8001->80-81/tcp'), [{ host: '8000-8001', container: '80-81', proto: 'tcp' }])
  assert.deepEqual(rules.parsePorts('127.0.0.1:53->53/udp'), [{ host: '53', container: '53', proto: 'udp' }])
  assert.equal(rules.portLabel({ host: '80', container: '80' }), '80')
  assert.equal(rules.portLabel({ host: '80', container: '8080' }), '80→8080')
  assert.equal(rules.firstPort({ host: '8000-8001' }), 8000)
})

test('an age in words becomes a number', () => {
  assert.equal(rules.ageSeconds('3 days ago'), 259_200)
  assert.equal(rules.ageSeconds('About an hour ago'), 3_600)
  assert.equal(rules.ageSeconds('About a minute ago'), 60)
  assert.equal(rules.ageSeconds('Less than a second ago'), 1)
  assert.equal(rules.ageSeconds('2 weeks ago'), 1_209_600)
  assert.equal(rules.ageSeconds('unknown'), null)
})

test('containers filter by state, and search finds any field a person might type', () => {
  const list = [
    container('web', { ports: '0.0.0.0:8000->80/tcp', compose_project: 'shop' }),
    container('db', { state: 'exited', image: 'postgres:16' }),
  ]
  const found = (query, filter = 'all') => names(rules.filterContainers(list, query, filter))
  assert.deepEqual(found('', 'running'), ['web'])
  assert.deepEqual(found('', 'stopped'), ['db'])
  assert.deepEqual(found('POSTGRES'), ['db'])
  assert.deepEqual(found('shop'), ['web'])
  assert.deepEqual(found(':8000'), ['web'])
  assert.deepEqual(found('db-id'), ['db'])
  assert.deepEqual(found('web', 'stopped'), [])
})

test('containers sort by real values, not by the text on screen', () => {
  const list = [
    container('b', { created_since: '9 hours ago', ports: '0.0.0.0:9000->80/tcp' }),
    container('a', { created_since: '2 days ago', ports: '0.0.0.0:80->80/tcp' }),
    container('c', { created_since: '1 minute ago', ports: '' }),
  ]
  const sorted = (key, dir) => names(rules.sortContainers(list, key, dir))
  assert.deepEqual(sorted('created', 'desc'), ['c', 'b', 'a'], 'newest first')
  assert.deepEqual(sorted('created', 'asc'), ['a', 'b', 'c'])
  assert.deepEqual(sorted('ports', 'asc'), ['a', 'b', 'c'], 'numbers, with no ports last')
  assert.deepEqual(sorted('ports', 'desc'), ['b', 'a', 'c'], 'no ports stay last')
  assert.deepEqual(sorted('project', 'asc'), ['a', 'b', 'c'], 'ties fall back to the name')
})

test('the status dot follows the state', () => {
  assert.equal(rules.containerDot('running'), 'running')
  assert.equal(rules.containerDot('paused'), 'partial')
  assert.equal(rules.containerDot('restarting'), 'partial')
  assert.equal(rules.containerDot('exited'), 'stopped')
})

test('images filter into groups that do not overlap, and pins are their own view', () => {
  const list = [
    image('used', '1', { in_use: true }),
    image('old', '1'),
    image('<none>', '<none>', { id: 'sha256:dangling' }),
  ]
  const found = (query, filter, pinned = []) => rules.filterImages(list, query, filter, pinned).map(rules.imageName)
  assert.deepEqual(found('', 'in-use'), ['used:1'])
  assert.deepEqual(found('', 'unused'), ['old:1'])
  assert.deepEqual(found('', 'dangling'), ['<none>'])
  assert.deepEqual(found('', 'pinned', ['sha256:old1']), ['old:1'])
  assert.deepEqual(found('used:1', 'all'), ['used:1'], 'a whole name with its tag is found, as a container row sends it')
  assert.deepEqual(found('dangling', 'all'), ['<none>'], 'an ID is found')
})

test('images sort by size in bytes, not by the size text', () => {
  const list = [image('small', '1', { size: '900MB', size_bytes: 900e6 }), image('big', '1', { size: '1.2GB', size_bytes: 1.2e9 })]
  assert.deepEqual(rules.sortImages(list, 'size', 'desc').map(i => i.repository), ['big', 'small'])
})

test('an image finds the containers that use it, however docker ps names it', () => {
  const latest = image('nginx', 'latest', { id: 'sha256:abcdef123456789' })
  const list = [
    container('tagged', { image: 'nginx:latest' }),
    container('bare', { image: 'nginx' }),
    container('by-id', { image: 'abcdef123456' }),
    container('other', { image: 'nginx:alpine' }),
  ]
  assert.deepEqual(names(rules.containersUsing(latest, list)), ['tagged', 'bare', 'by-id'])
  const pinned = image('nginx', '1.27', { id: 'sha256:999' })
  assert.deepEqual(names(rules.containersUsing(pinned, [container('bare', { image: 'nginx' })])), [], 'no tag means latest')
})

test('volumes filter, search their containers, and unknown sizes stay last', () => {
  const list = [
    volume('data', { in_use: true, containers: ['db'], size_bytes: 5 }),
    volume('cache', { size_bytes: 9 }),
    volume('new'),
  ]
  assert.deepEqual(names(rules.filterVolumes(list, '', 'in-use')), ['data'])
  assert.deepEqual(names(rules.filterVolumes(list, '', 'unused')), ['cache', 'new'])
  assert.deepEqual(names(rules.filterVolumes(list, 'db', 'all')), ['data'])
  assert.deepEqual(names(rules.sortVolumes(list, 'size', 'desc')), ['cache', 'data', 'new'])
  assert.deepEqual(names(rules.sortVolumes(list, 'size', 'asc')), ['data', 'cache', 'new'])
})

test('networks tell Docker\'s own apart, and options read as words', () => {
  const list = [network('bridge'), network('shop_default', { driver: 'overlay' })]
  assert.deepEqual(names(rules.filterNetworks(list, '', 'built-in')), ['bridge'])
  assert.deepEqual(names(rules.filterNetworks(list, '', 'custom')), ['shop_default'])
  assert.deepEqual(names(rules.filterNetworks(list, 'overlay', 'all')), ['shop_default'])
  assert.equal(rules.networkOptions(network('a', { internal: true, ipv6: true })), 'Internal, IPv6')
  assert.equal(rules.networkOptions(network('a')), '')
})

test('cleanup never offers a pinned image or one in use', () => {
  const pinned = image('pinned', '1')
  const dangling = image('<none>', '<none>')
  const unused = image('unused', '1')
  const inUse = image('used', '1', { in_use: true })
  const removable = rules.removableImages([pinned, dangling, unused, inUse], [pinned.id])
  assert.deepEqual(removable, [dangling, unused])
  assert.deepEqual(rules.removableImages([image('<none>', '<none>', { id: 'a' })], ['a']), [], 'a pinned dangling image stays too')
})

test('Nuclear prune can run with no unused images, the other levels cannot', () => {
  assert.equal(rules.canRunPrune({ level: 3, image_ids: [] }), true, 'containers, volumes, and build cache still go')
  assert.equal(rules.canRunPrune({ level: 3, image_ids: ['a'] }), true)
  assert.equal(rules.canRunPrune({ level: 2, image_ids: [] }), false)
  assert.equal(rules.canRunPrune({ level: 2, image_ids: ['a'] }), true)
  assert.equal(rules.canRunPrune({ level: 1, image_ids: [] }), false)
})

test('sorting leaves the list it was given alone', () => {
  const list = [container('b'), container('a')]
  rules.sortContainers(list, 'name', 'asc')
  assert.deepEqual(names(list), ['b', 'a'])
})
