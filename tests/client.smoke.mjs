/**
 * Client-half smoke test: loads lib/client.js against DSH's module-loader
 * contract in a minimal DOM stub, then asserts the plugin registers one
 * sidebar tab and that the tab component is constructible.
 *
 * This catches the failure modes a runtime-only bug report would show: a
 * broken envelope, missing require() wiring, CSS not injected, or a
 * descriptor that never reaches ctx.betterSidebar.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { strict as assert } from 'node:assert'

// ---- minimal DOM so the CSS <style> injection path runs ----
const head = []
globalThis.document = {
  head: { appendChild: (n) => head.push(n) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
}

// ---- DSH's module loader envelope ----
const react = await import('react')
const jsxRuntime = await import('react/jsx-runtime')
let loaded
const fakeWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const req = (name) => {
        if (name === 'react') return react
        if (name === 'react/jsx-runtime') return jsxRuntime
        throw new Error('unexpected require: ' + name)
      }
      loaded = { id, exports: factory(req) }
    },
  },
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// Evaluate the bundle the way the browser would: as a script seeing `window`.
new Function('window', 'globalThis', source)(fakeWindow, globalThis)

assert.ok(loaded !== undefined, 'bundle called __ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-sidebar-downloads', 'loader id matches the package name')
assert.deepEqual(loaded.exports.inject, ['betterSidebar'], 'declares the betterSidebar inject')
assert.equal(typeof loaded.exports.apply, 'function', 'exports apply()')
console.log('PASS envelope: id, inject and apply are wired')

// ---- registration ----
const tabs = []
const ctx = {
  betterSidebar: {
    registerTab(descriptor) { tabs.push(descriptor); return () => {} },
  },
  effect(cb) { cb() },
}
loaded.exports.apply(ctx)

assert.equal(tabs.length, 1, 'registers exactly one tab')
const tab = tabs[0]
assert.equal(tab.id, 'dsh-sidebar-downloads')
assert.equal(tab.single, true, 'single-instance tab')
assert.equal(typeof tab.component, 'function', 'has a component')
assert.equal(tab.title(), '下载')
assert.ok(tab.icon(16) !== undefined, 'icon factory returns a node')
assert.equal(typeof tab.description(), 'string', 'declares a description')
console.log('PASS registration: one tab, id/title/icon/description/single all set')

// ---- CSS injection ----
assert.equal(head.length, 1, 'injected exactly one style tag')
assert.ok(head[0].textContent.includes('sidebarDownloadsPulse'), 'stylesheet content injected')
assert.ok(head[0].dataset.pluginCss.indexOf('dsh-sidebar-downloads/') === 0, 'style tag is namespaced')
console.log('PASS css: one namespaced style tag injected')

// ---- render the initial state ----
const html = renderToStaticMarkup(createElement(tab.component, { visible: false, ctx: {} }))
assert.ok(html.indexOf('载入中') >= 0, 'renders the initial state without throwing')
console.log('PASS render: tab component renders its initial state')

console.log('')
console.log('All client-half smoke tests passed.')
