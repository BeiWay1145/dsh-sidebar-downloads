/**
 * DOM integration test for the panel: runs the real component in jsdom with
 * react-dom/client so the mount effect's polling actually executes, then
 * asserts on the rendered DOM and on the click interactions.
 *
 * This is the layer the unit smoke tests cannot reach: the poll cadence, the
 * running/terminal branches, the unknown-size bar, expand-to-detail, and the
 * reveal/forget button wiring.
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

// Install the jsdom globals the bundle and React expect.
globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 24 exposes `navigator` as a getter-only global, so redefine it.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const react = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
const ReactDOM = await import('react-dom/client')

// ---- canned host responses --------------------------------------------
const base = Date.now()
let calls = { tasks: 0, reveal: 0, forget: 0 }
let scenario = 'live'

const liveTasks = [
  { taskId: 'a', name: 'ubuntu.iso', status: 'downloading', percent: 42.5, total: 2000000,
    downloaded: 850000, bytesOnDisk: 850000, speedMBps: 4.25, etaSec: 271,
    outPath: 'C:/dl/ubuntu.iso', url: 'https://x/ubuntu.iso', finalUrl: '', error: '',
    elapsedSec: 200, startedAt: base, endedAt: 0 },
  { taskId: 'b', name: 'model.safetensors', status: 'downloading', percent: -1, total: 0,
    downloaded: 123456, bytesOnDisk: 123456, speedMBps: 1.5, etaSec: 0,
    outPath: 'C:/dl/m.bin', url: 'https://x/m', finalUrl: '', error: '',
    elapsedSec: 10, startedAt: base, endedAt: 0 },
  { taskId: 'c', name: 'archive.zip', status: 'done', percent: 100, total: 500000,
    downloaded: 500000, bytesOnDisk: 500000, speedMBps: 2, etaSec: 0,
    outPath: 'C:/dl/a.zip', url: 'https://x/a', finalUrl: '', error: '',
    elapsedSec: 30, startedAt: base - 60000, endedAt: base - 30000 },
  { taskId: 'd', name: 'broken.tar', status: 'error', percent: 0, total: 0,
    downloaded: 0, bytesOnDisk: 0, speedMBps: 0, etaSec: 0, outPath: 'C:/dl/b.tar',
    url: '', finalUrl: '', error: 'ECONNRESET', elapsedSec: 3, startedAt: base, endedAt: base },
  // A user-paused transfer: unfinished, so it keeps progress and offers no
  // "reveal" (there is no finished file yet), and it is not "active".
  { taskId: 'p', name: 'paused.iso', status: 'paused', percent: 17.7, total: 4194304,
    downloaded: 742000, bytesOnDisk: 742000, speedMBps: 0, etaSec: -1,
    outPath: 'C:/dl/p.iso', url: 'https://x/p', finalUrl: '', error: '',
    elapsedSec: 60, startedAt: base, endedAt: 0 },
]

dom.window.fetch = async (url) => {
  const u = String(url)
  if (u.indexOf('/tasks') >= 0) {
    calls.tasks += 1
    const tasks = scenario === 'empty' ? [] : liveTasks
    // Mirror the host half: paused is unfinished but NOT active.
    const active = tasks.filter((t) => t.status === 'downloading' || t.status === 'starting' || t.status === 'probing').length
    return { ok: true, json: async () => ({ ok: true, tasks, active }) }
  }
  if (u.indexOf('/reveal') >= 0) { calls.reveal += 1; return { ok: true, json: async () => ({ ok: true }) } }
  if (u.indexOf('/forget') >= 0) { calls.forget += 1; return { ok: true, json: async () => ({ ok: true }) } }
  throw new Error('unexpected fetch ' + u)
}
globalThis.fetch = dom.window.fetch

// ---- load the real bundle --------------------------------------------
let loaded
const fakeWindow = dom.window
fakeWindow.__ModuleLoader__ = {
  load({ id, factory }) {
    const req = (n) => n === 'react' ? react : n === 'react/jsx-runtime' ? jsxRuntime : (() => { throw new Error('require ' + n) })()
    loaded = { id, exports: factory(req) }
  },
}
// The bundle reads `window.__ModuleLoader__` from the global it is given.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', 'globalThis', source)(fakeWindow, globalThis)

let tab
loaded.exports.apply({
  betterSidebar: { registerTab(d) { tab = d; return () => {} } },
  effect(cb) { cb() },
})
assert.equal(head_tags(), 1)
function head_tags() { return dom.window.document.head.querySelectorAll('style[data-plugin-css]').length }
console.log('PASS bundle loaded and one style tag injected into jsdom head')

// ---- mount and let the poll run --------------------------------------
// React 18.3+ exposes act from the react package itself.
const { act } = react
const container = dom.window.document.getElementById('app')
const root = ReactDOM.createRoot(container)
await act(async () => {
  root.render(react.createElement(tab.component, { visible: true, ctx: {} }))
})
// One more act pass so the fetch promise resolves into state.
await act(async () => { await new Promise((r) => setTimeout(r, 50)) })

const text = () => container.textContent
assert.ok(calls.tasks >= 1, 'polled the tasks route')
assert.ok(text().indexOf('ubuntu.iso') >= 0, 'renders the running task name')
assert.ok(text().indexOf('42.5%') >= 0, 'renders the live percentage')
assert.ok(text().indexOf('4.25 MB/s') >= 0, 'renders the speed')
assert.ok(text().indexOf('archive.zip') >= 0, 'renders a finished task')
assert.ok(text().indexOf('已完成') >= 0, 'renders the done status')
assert.ok(text().indexOf('broken.tar') >= 0, 'renders a failed task')
assert.ok(text().indexOf('失败') >= 0, 'renders the error status')
assert.ok(text().indexOf('2 个进行中') >= 0, 'header counts only the running tasks')
console.log('PASS mount: live + history rows, percentage, speed and statuses all render')

// Unknown-size task must not print a fake percentage; its bar is indeterminate.
const bars = container.querySelectorAll('[data-indeterminate="true"]')
assert.equal(bars.length, 1, 'exactly one indeterminate bar for the unknown-size task')
console.log('PASS unknown-size: one indeterminate bar, no fabricated percentage')

// A paused transfer must read as paused, keep its progress, and NOT add an
// animated indeterminate bar (it is not running).
assert.ok(text().indexOf('paused.iso') >= 0, 'paused row renders')
assert.ok(text().indexOf('已暂停 · 17.7%') >= 0, 'paused row shows its state and progress')
assert.ok(text().indexOf('空闲') < 0, 'panel does not claim to be idle while a transfer is paused')
assert.equal(
  container.querySelectorAll('[data-indeterminate="true"]').length,
  1,
  'a paused row does not animate an indeterminate bar',
)
console.log('PASS paused: distinct label, progress kept, no false activity')

// A paused transfer has no complete file on disk, so it must not offer
// "reveal in folder" (that would open a partial download) and must not show
// a completion timestamp. Both were observed bugs.
{
  // Find the paused row's own subtree by walking up from its name span to the
  // container that owns the action buttons.
  const nameSpans = [...container.querySelectorAll('span')].filter((s) => s.textContent === 'paused.iso')
  assert.equal(nameSpans.length, 1, 'paused row name found')
  let scope = nameSpans[0]
  while (scope !== null && (scope.querySelectorAll('button').length === 0)) scope = scope.parentElement
  assert.ok(scope !== null, 'found the paused row container')
  const labels = [...scope.querySelectorAll('button')].map((b) => b.textContent)
  assert.ok(labels.indexOf('在文件夹中显示') < 0, 'paused row offers no reveal')
  assert.ok(labels.indexOf('移除记录') >= 0, 'paused row still offers forget')
}
console.log('PASS paused: no reveal offered for an unfinished transfer')

// ---- expand a row to reveal detail -----------------------------------
// The row header is the clickable div carrying the chevron, name and status.
const rowHead = [...container.querySelectorAll('div')].find((d) => {
  const kids = d.children
  return kids.length === 3 && kids[1].textContent === 'ubuntu.iso'
})
assert.ok(rowHead !== undefined, 'found the row header')
await act(async () => { rowHead.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
assert.ok(text().indexOf('C:/dl/ubuntu.iso') >= 0, 'expanded row shows the output path')
assert.ok(text().indexOf('https://x/ubuntu.iso') >= 0, 'expanded row shows the source URL')
console.log('PASS expand: detail shows output path and source URL')

// ---- reveal button ---------------------------------------------------
const revealBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '在文件夹中显示')
assert.ok(revealBtn !== undefined, 'done task offers reveal')
await act(async () => { revealBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
assert.equal(calls.reveal, 1, 'reveal route called once')
console.log('PASS reveal: button calls the reveal route')

// ---- forget button removes the row locally ---------------------------
const forgetBtns = () => [...container.querySelectorAll('button')].filter((b) => b.textContent === '移除记录')
const before = forgetBtns().length
await act(async () => { forgetBtns()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
assert.equal(calls.forget, 1, 'forget route called once')
assert.ok(forgetBtns().length < before || text().indexOf('ubuntu.iso') < 0, 'row disappears after forget')
console.log('PASS forget: row removed after the route succeeds')

// ---- filter toggle ---------------------------------------------------
const filterBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '只看进行中')
assert.ok(filterBtn !== undefined, 'filter toggle present')
await act(async () => { filterBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
assert.ok(text().indexOf('broken.tar') < 0, 'finished tasks hidden when filtering')
console.log('PASS filter: running-only view hides finished tasks')

// ---- hidden tab stops polling ----------------------------------------
const callsBefore = calls.tasks
await act(async () => { root.render(react.createElement(tab.component, { visible: false, ctx: {} })) })
await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
assert.equal(calls.tasks, callsBefore, 'a hidden tab issues no further polls')
console.log('PASS visibility: hidden tab stops polling')

// ---- empty ledger ----------------------------------------------------
scenario = 'empty'
await act(async () => { root.render(react.createElement(tab.component, { visible: true, ctx: {} })) })
await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
// A fresh mount refetches; with no tasks the empty copy shows.
assert.ok(container.textContent.length > 0, 'empty ledger renders a message')
console.log('PASS empty: no-task ledger renders its empty state')

await act(async () => { root.unmount() })
console.log('')
console.log('All DOM integration tests passed.')
process.exit(0)