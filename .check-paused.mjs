
const routes = []
const ctx = { webServer: { register(r) { routes.push(r); return () => {} } }, effect(cb) { cb() } }
const mod = await import('./lib/index.js')
mod.apply(ctx)
function res() { const s = { code: 0, body: '' }; return { s, writeHead(c) { s.code = c }, end(b) { s.body = b } } }
const r = res()
await routes[0].handler({ url: mod.API_PREFIX + '/tasks', method: 'GET' }, r)
const data = JSON.parse(r.s.body)
console.log('active:', data.active)
for (const t of data.tasks) {
  console.log(JSON.stringify({ name: t.name, status: t.status, source: t.source, percent: t.percent, speedMBps: t.speedMBps, etaSec: t.etaSec, downloaded: t.downloaded, total: t.total }, null, 1))
}
