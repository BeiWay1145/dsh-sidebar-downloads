/**
 * Host-half smoke test: drives the real route handler against synthetic
 * task records in a temporary HOME, covering the states the panel renders
 * (active / done / error / torn record / no Content-Length).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs'
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
// A UTF-8 BOM ahead of the JSON: PowerShell's `Set-Content -Encoding utf8`
// produces this, and JSON.parse rejects it unless it is stripped.
writeFileSync(join(TASKS, 'bom-jkl.json'), '\uFEFF' + JSON.stringify({
  name: 'bom.bin', status: 'done', total: 10, downloaded: 10, percent: 100,
  startedAt: Date.now(), endedAt: Date.now(),
}))

// A stale `--no-wait` record exactly as aria2-dl.js writes it: a GID and
// all-zero counters. The RPC stub below stands in for a running engine.
writeFileSync(join(TASKS, 'aria2-stale.json'), JSON.stringify({
  name: 'big.iso', url: 'https://example.com/big.iso', gid: 'deadbeef',
  outPath: join(HOME, 'big.iso'), status: 'starting', startedAt: Date.now(),
  percent: 0, downloaded: 0, total: 0, speedMBps: 0, etaSec: -1,
}))

// A user-paused aria2 transfer: unfinished, but NOT running.
writeFileSync(join(TASKS, 'aria2-paused.json'), JSON.stringify({
  name: 'paused.bin', url: 'https://example.com/paused.bin', gid: 'pausedgid',
  outPath: join(HOME, 'paused.bin'), status: 'starting', startedAt: Date.now(),
  percent: 0, downloaded: 0, total: 0, speedMBps: 0, etaSec: -1,
}))

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

// Stand in for the aria2 engine: answer tellStatus for the stale GID with
// the real transfer state, and fail for anything else (engine-down behavior).
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (body.params[0] === 'pausedgid') {
    return {
      ok: true,
      json: async () => ({
        result: {
          status: 'paused',
          totalLength: '4194304',
          completedLength: '2097152',
          downloadSpeed: '0',
          files: [{ path: join(HOME, 'paused.bin') }],
        },
      }),
    }
  }
  if (body.params[0] === 'deadbeef') {
    return {
      ok: true,
      json: async () => ({
        result: {
          status: 'active',
          totalLength: '4194304',
          completedLength: '1048576',
          downloadSpeed: '2097152',
          files: [{ path: join(HOME, 'big.iso') }],
        },
      }),
    }
  }
  throw new Error('engine down')
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
  // Two: the ledger's own downloading record, plus the aria2-backed one the
  // RPC reports as active.
  assert.equal(data.active, 2, 'both active tasks counted')
  // Torn record + non-json skipped; the four real records survive.
  assert.equal(data.tasks.length, 6, 'torn/non-json records are skipped')
  assert.ok(
    data.tasks.some((t) => t.taskId === 'bom-jkl'),
    'a BOM-prefixed record is still parsed',
  )
  // Ordering contract: active tasks rank above terminal ones. (Which active
  // task leads is decided by recency, so assert the ranking, not the identity.)
  const firstTerminal = data.tasks.findIndex((t) => t.status !== 'downloading' && t.status !== 'starting')
  assert.ok(data.tasks.slice(0, firstTerminal).every((t) => t.status === 'downloading' || t.status === 'starting'),
    'active tasks sort before terminal ones')
  assert.ok(firstTerminal > 0, 'at least one active task ranks first')
  const done = data.tasks.find((t) => t.taskId === 'done-def')
  assert.ok(done !== undefined, 'done record present')
  assert.equal(done.status, 'done')
  const bad = data.tasks.find((t) => t.taskId === 'bad-ghi')
  assert.equal(bad.error, 'ECONNRESET', 'error text preserved')
  assert.equal(bad.bytesOnDisk, 0, 'missing output file reports 0 bytes')
  console.log('PASS /tasks: sorted, torn record skipped, BOM tolerated, fields normalized')

  // The aria2-backed record must show the ENGINE's numbers, not the frozen
  // zeros its ledger file holds — "0.53 GB / 0.00 GB" was the observed bug.
  const aria = data.tasks.find((t) => t.taskId === 'aria2-stale')
  assert.ok(aria !== undefined, 'aria2-backed record present')
  assert.equal(aria.source, 'aria2', 'record was refreshed from the engine')
  assert.equal(aria.status, 'downloading', 'engine status wins over the stale ledger status')
  assert.equal(aria.total, 4194304, 'total comes from aria2')
  assert.equal(aria.downloaded, 1048576, 'downloaded comes from aria2')
  assert.equal(aria.percent, 25)
  assert.equal(aria.speedMBps, 2, 'speed comes from aria2')
  assert.ok(aria.etaSec > 0, 'eta derived from aria2')
  console.log('PASS aria2: a stale --no-wait record is refreshed from the RPC')

  // A paused transfer keeps its byte counts but must not be advertised as
  // running — it would otherwise animate a stalled bar and overcount the
  // header's "N running".
  const paused = data.tasks.find((t) => t.taskId === 'aria2-paused')
  assert.ok(paused !== undefined, 'paused record present')
  assert.equal(paused.status, 'paused', 'paused stays its own state')
  assert.equal(paused.percent, 50, 'paused keeps its progress')
  assert.equal(paused.downloaded, 2097152)
  assert.equal(data.active, 2, 'a paused task is not counted as active')
  console.log('PASS aria2: a paused transfer is reported as paused, not running')
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

// --- /tasks reports the ledger's own state ------------------------------
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/tasks'), res)
  const data = JSON.parse(res.state.body)
  assert.equal(data.dirExists, true, 'an existing tasks dir is reported as present')
  assert.equal(typeof data.dir, 'string', 'the dir path is echoed for diagnostics')
  console.log('PASS /tasks: reports dirExists when the ledger directory exists')
}

// --- a missing ledger directory is NOT reported as an ordinary empty list -
{
  // Move the tasks dir aside so readdirSync fails the way a cleaned ledger does.
  const parked = TASKS + '-parked'
  rmSync(parked, { recursive: true, force: true })
  renameSync(TASKS, parked)
  try {
    const res = fakeRes()
    await route.handler(fakeReq(mod.API_PREFIX + '/tasks'), res)
    assert.equal(res.state.code, 200, 'still a successful response')
    const data = JSON.parse(res.state.body)
    assert.equal(data.dirExists, false, 'a missing directory is reported explicitly')
    assert.deepEqual(data.tasks, [], 'and there are no tasks')
    assert.ok(data.dir.includes('tasks'), 'the missing path is echoed')
    console.log('PASS /tasks: a missing ledger directory is distinguishable from empty')
  } finally {
    renameSync(parked, TASKS)
  }
}

// --- /reveal marks a vanished record as stale ---------------------------
{
  const res = fakeRes()
  await route.handler(fakeReq(mod.API_PREFIX + '/reveal?taskId=long-gone'), res)
  assert.equal(res.state.code, 404)
  const body = JSON.parse(res.state.body)
  assert.equal(body.stale, true, 'a missing record is flagged stale so the panel can drop the row')
  console.log('PASS /reveal: a vanished record is flagged stale')
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
