/**
 * Host-half smoke test: drives the real route handler against synthetic
 * task records in a temporary HOME, covering the states the panel renders
 * (active / done / error / torn record / no Content-Length).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strict as assert } from 'node:assert'

const HOME = join(tmpdir(), 'dsh-sidebar-downloads-test-' + Date.now())
const TASKS = join(HOME, '.dsh', 'downloads', 'tasks')
mkdirSync(TASKS, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME

writeFileSync(join(TASKS, 'active-abc.json'), JSON.stringify({
  name: 'model.bin', status: 'downloading', total: 1000, downloaded: 250,
  percent: 25, speedMBps: 2.5, etaSec: 300, outPath: join(HOME, 'model.bin'),
  startedAt: Date.now(), url: 'https://example.com/model.bin',
}))
writeFileSync(join(TASKS, 'done-def.json'), JSON.stringify({
  name: 'archive.zip', status: 'done', total: 500, downloaded: 500, percent: 100,
  endedAt: Date.now(), startedAt: Date.now() - 5000, outPath: join(HOME, 'archive.zip'),
}))
writeFileSync(join(TASKS, 'bad-ghi.json'), JSON.stringify({ name: 'failed.iso', status: 'error', error: 'ECONNRESET' }))
writeFileSync(join(TASKS, 'torn.json'), '{ "name": "half-writ')
writeFileSync(join(TASKS, 'ignore.txt'), 'not json')

// Minimal stubs: a fake ServerResponse capturing the JSON body.
function fakeRes() {
  const state = { code: 0, body: '' }
  return {
    state,
    writeHead(code) { state.code = code },
    end(body) { state.body = body },
  }
}

function fakeReq(url) {
  return { url, method: 'GET' }
}

// Route the handler through the plugin's own apply(), so registration is
// exercised the same way cordis does it.
const routes = []
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {} } },
  effect(cb) { cb() },
}

const mod = await import('../lib/index.js')
mod.apply(ctx)
assert.equal(routes.length, 1, 'registers exactly one route')
const route = routes[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, mod.API_PREFIX)

// --- /tasks ---
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/tasks'), res)
  assert.equal(res.state.code, 200)
  const data = JSON.parse(res.state.body)
  assert.equal(data.ok, true)
  assert.equal(data.active, 1, 'one active task')
  // Torn record + non-json skipped; the four real records survive.
  assert.equal(data.tasks.length, 3, 'torn/non-json records are skipped')
  assert.equal(data.tasks[0].name, 'model.bin', 'active task sorts first')
  const done = data.tasks.find((t) => t.taskId === 'done-def')
  assert.ok(done !== undefined, 'done record present')
  assert.equal(done.status, 'done')
  const bad = data.tasks.find((t) => t.taskId === 'bad-ghi')
  assert.equal(bad.error, 'ECONNRESET', 'error text preserved')
  assert.equal(bad.bytesOnDisk, 0, 'missing output file reports 0 bytes')
  console.log('PASS /tasks: sorted, torn record skipped, fields normalized')
}

// --- /reveal rejects traversal ---
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/reveal?taskId=' + encodeURIComponent('../secret')), res)
  assert.equal(res.state.code, 400, 'path traversal refused')
  console.log('PASS /reveal: traversal refused with 400')
}

// --- /reveal on unknown task ---
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/reveal?taskId=nope'), res)
  assert.equal(res.state.code, 404)
  console.log('PASS /reveal: unknown task reports 404')
}

// --- /forget removes only the record ---
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/forget?taskId=done-def'), res)
  assert.equal(res.state.code, 200)
  assert.equal(JSON.parse(res.state.body).ok, true)
  assert.equal(existsSync(join(TASKS, 'done-def.json')), false, 'record removed')
  // ...but the other records are untouched.
  assert.equal(existsSync(join(TASKS, 'active-abc.json')), true)
  console.log('PASS /forget: record removed, siblings intact')
}

// --- unknown route ---
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/whatever'), res)
  assert.equal(res.state.code, 404)
  console.log('PASS unknown route reports 404')
}

rmSync(HOME, { recursive: true, force: true })
console.log('\nAll host-half smoke tests passed.')
