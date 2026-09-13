/**
 * dsh-sidebar-downloads — host half.
 *
 * Reads the download task ledger (`~/.dsh/downloads/tasks/*.json`, one file
 * per task) and republishes it over HTTP for the client half, plus the two
 * file actions the panel offers (reveal in Explorer / forget a record).
 *
 * ONE producer writes that ledger: the aria2 channel's `aria2-dl.js` (the
 * forwarder every download now goes through — `dsh-download-guard` denies any
 * shell command that would bypass it). The former hand-rolled
 * `download.cjs` producer is gone, so the ledger is no longer a mixed pool of
 * differently-fresh records.
 *
 * That single producer still needs correcting, though: `aria2-dl.js` writes
 * its record only ONCE at enqueue time, and refreshes it only while blocking
 * (`--wait`). A task enqueued with `--no-wait` — the normal way an agent
 * starts a big download — leaves a frozen `starting` record with all-zero
 * counters while the transfer runs to completion. Trusting the file there
 * renders "0%" forever, or worse, pairs a stale `total: 0` with live bytes
 * on disk and prints an impossible "3.62 GB / 0.00 GB".
 *
 * So a record carrying a `gid` is refreshed from the aria2 RPC, which is the
 * real owner of that transfer's state. If aria2 is not running, the record is
 * served unchanged — enrichment degrades to "show what the ledger says",
 * never to an error.
 *
 * Contract notes:
 * - `inject: ['webServer']` is mandatory: cordis throws
 *   "cannot get property \"webServer\" without inject" when an undeclared
 *   service is read off ctx, which fails the whole plugin tree at boot.
 * - Everything else uses node built-ins (fs / child_process), so this half
 *   has no dependency on ctx.fs or ctx.subprocess.
 * - Every route is registered through `ctx.effect`, so disposal (and HMR
 *   reactivation) unregisters it cleanly.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The local aria2-next RPC (Motrix Next's engine). Loopback only, no secret. */
const ARIA2_RPC = 'http://127.0.0.1:16800/jsonrpc';
/** Keep the panel responsive: a dead engine must not stall the task list. */
const ARIA2_TIMEOUT_MS = 1500;

/** Minimal structural view of the two cordis services this half touches, so
 *  the package needs no dependency on the DSH type packages. */
interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}
interface PluginContext {
  webServer: WebServerService
  effect(callback: () => (() => void) | void, label?: string): void
}

/** One normalized task record handed to the client half. */
interface TaskRecord {
  taskId: string
  name: string
  url: string
  finalUrl: string
  outPath: string
  status: string
  error: string
  total: number
  downloaded: number
  percent: number
  speedMBps: number
  elapsedSec: number
  etaSec: number
  startedAt: number
  endedAt: number
  bytesOnDisk: number
  /** aria2 GID when the task came from that channel (else ''). */
  gid: string
  /** Where the numbers came from: 'aria2' when live-refreshed, else 'ledger'. */
  source: 'aria2' | 'ledger'
}

const HOME = homedir();
const TASKS_DIR = join(HOME, '.dsh', 'downloads', 'tasks');

/** Route prefix; the client half mirrors these paths. */
export const API_PREFIX = '/api/sidebar-downloads';

/** cordis inject declaration — the only service this half depends on. */
export const inject = ['webServer'];

/** Statuses that mean "work is happening right now". */
const ACTIVE = new Set(['downloading', 'starting', 'probing']);

/** The subset of aria2's tellStatus reply this plugin consumes. */
interface Aria2Status {
  status?: string
  totalLength?: string
  completedLength?: string
  downloadSpeed?: string
  errorMessage?: string
  files?: { path?: string }[]
}

/**
 * Ask the aria2 engine about one GID.
 *
 * Returns undefined when aria2 is not running, the GID is unknown (so the
 * transfer is long gone from its session), or the call is slow — in every one
 * of those cases the caller keeps the ledger's own numbers.
 */
async function aria2Status(gid: string): Promise<Aria2Status | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ARIA2_TIMEOUT_MS)
  try {
    const res = await fetch(ARIA2_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'sidebar-downloads', method: 'aria2.tellStatus', params: [gid] }),
      signal: controller.signal,
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { result?: Aria2Status }
    return body.result
  } catch {
    // Engine down, aborted, or a non-JSON reply: fall back to the ledger.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Map an aria2 transfer status onto this plugin's vocabulary.
 *
 * `paused` stays its own state rather than collapsing into `downloading`:
 * a paused transfer has no speed and will never finish on its own, so
 * rendering it as an active download would both animate a stalled bar and
 * overcount the header's "N running".
 */
function aria2TaskStatus(s: string): string {
  switch (s) {
    case 'active':
    case 'waiting':
      return 'downloading'
    case 'paused':
      return 'paused'
    case 'complete':
      return 'done'
    case 'error':
      return 'error'
    case 'removed':
      return 'cancelled'
    default:
      return 'downloading'
  }
}

/**
 * Overlay live aria2 state onto a ledger record.
 *
 * Only fields aria2 actually owns are replaced; `name`, `startedAt` and the
 * record's identity stay as the ledger wrote them.
 */
function mergeAria2(task: TaskRecord, a: Aria2Status): TaskRecord {
  const total = Number(a.totalLength ?? 0) || 0
  const done = Number(a.completedLength ?? 0) || 0
  const speed = Number(a.downloadSpeed ?? 0) || 0
  const status = aria2TaskStatus(String(a.status ?? ''))
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 1000) / 10) : 0
  // Prefer aria2's own path when it reports one; it knows the final filename
  // after any auto-renaming the engine did.
  const ariaPath = a.files?.[0]?.path ?? ''
  return {
    ...task,
    status,
    // aria2 reports byte counts as strings; numbers land here so the client
    // never has to care which producer wrote the record.
    total,
    downloaded: done,
    percent: pct,
    speedMBps: Math.round((speed / 1048576) * 100) / 100,
    etaSec: speed > 0 && total > 0 ? Math.round((total - done) / speed) : -1,
    error: String(a.errorMessage ?? '') || task.error,
    outPath: ariaPath !== '' ? ariaPath : task.outPath,
    // Byte count for a live transfer is the engine's, not a stat() of a file
    // that may be a preallocated sparse placeholder.
    bytesOnDisk: status === 'done' ? (task.outPath ? fileSize(ariaPath || task.outPath) : done) : done,
    endedAt: status === 'downloading' || status === 'paused' ? 0 : task.endedAt || Date.now(),
    source: 'aria2',
  }
}

/**
 * Read every task record. A malformed or half-written JSON file is skipped
 * rather than failing the whole listing: records are written by another
 * process (aria2-dl.js), so a torn read is always possible and must never
 * surface as an error to the panel.
 */
async function readTasks(): Promise<TaskRecord[]> {
  let entries: string[];
  try {
    entries = readdirSync(TASKS_DIR);
  } catch {
    return [];
  }
  const tasks: TaskRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const taskId = name.slice(0, -'.json'.length);
    try {
      const obj = parseRecord(readFileSync(join(TASKS_DIR, name), 'utf8'));
      if (obj === null || typeof obj !== 'object') continue;
      const name_ = str(obj.name);
      if (name_ === '') continue;
      tasks.push({
        taskId,
        name: name_,
        url: str(obj.url),
        finalUrl: str(obj.finalUrl),
        outPath: str(obj.outPath),
        status: str(obj.status) || 'unknown',
        error: str(obj.error),
        total: num(obj.total),
        downloaded: num(obj.downloaded),
        // percent is -1 when the server sent no Content-Length.
        percent: num(obj.percent),
        speedMBps: num(obj.speedMBps),
        elapsedSec: num(obj.elapsedSec),
        etaSec: num(obj.etaSec),
        startedAt: num(obj.startedAt),
        endedAt: num(obj.endedAt),
        // Bytes actually on disk right now, which is authoritative when a
        // download was killed without writing a final record.
        bytesOnDisk: fileSize(obj.outPath),
        gid: str(obj.gid),
        source: 'ledger',
      });
    } catch {
      /* torn or malformed record — skip */
    }
  }
  // Refresh every aria2-backed record from the engine, which owns that
  // transfer's real state (see the header note on --no-wait records).
  const live = tasks.filter((t) => t.gid !== '');
  if (live.length > 0) {
    const statuses = await Promise.all(live.map((t) => aria2Status(t.gid)));
    for (let i = 0; i < live.length; i += 1) {
      const status = statuses[i];
      const task = live[i];
      if (status === undefined || task === undefined) continue;
      const merged = mergeAria2(task, status);
      const at = tasks.indexOf(task);
      if (at >= 0) tasks[at] = merged;
    }
  }
  // Active first, then most recent.
  tasks.sort((a, b) => {
    const ra = ACTIVE.has(a.status) ? 0 : 1;
    const rb = ACTIVE.has(b.status) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.startedAt || b.endedAt || 0) - (a.startedAt || a.endedAt || 0);
  });
  return tasks;
}

/**
 * Parse a task record.
 *
 * The ledger is written by other tooling, so tolerate a UTF-8 BOM: a record
 * round-tripped through PowerShell's `Set-Content -Encoding utf8` carries
 * one, and `JSON.parse` rejects it outright. Stripping it costs nothing and
 * turns a silently-dropped task into a rendered one.
 */
function parseRecord(text: string): Record<string, unknown> {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(clean) as Record<string, unknown>;
}

/** Read a field as a string; anything else (including absent) becomes ''. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function fileSize(path: unknown): number {
  if (typeof path !== 'string' || path === '') return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  } catch {
    /* socket already gone */
  }
}

/** Resolve a task id to its record path, refusing anything path-like. */
function taskFile(taskId: unknown): string | undefined {
  if (typeof taskId !== 'string' || taskId === '') return undefined;
  // A task id is a filename stem; reject separators and traversal so a
  // crafted query can never reach outside the tasks directory.
  if (taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) return undefined;
  return join(TASKS_DIR, taskId + '.json');
}

export function apply(ctx: PluginContext): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const route = url.pathname.startsWith(API_PREFIX)
            ? url.pathname.slice(API_PREFIX.length) || '/'
            : '/';

          if (route === '/tasks') {
            const tasks = await readTasks();
            return sendJson(res, 200, {
              ok: true,
              tasks,
              active: tasks.filter((t) => ACTIVE.has(t.status)).length,
            });
          }

          if (route === '/reveal') {
            const file = taskFile(url.searchParams.get('taskId') ?? '');
            if (file === undefined) return sendJson(res, 400, { ok: false, error: 'taskId 非法' });
            let outPath = '';
            try {
              outPath = JSON.parse(readFileSync(file, 'utf8')).outPath ?? '';
            } catch {
              return sendJson(res, 404, { ok: false, error: '找不到该任务' });
            }
            if (!outPath) return sendJson(res, 404, { ok: false, error: '任务缺少输出路径' });
            // Explorer /select highlights the file; the trailing comma is the
            // documented form for that switch.
            execFile('explorer.exe', ['/select,' + outPath], { windowsHide: true }, () => {});
            return sendJson(res, 200, { ok: true });
          }

          if (route === '/forget') {
            const file = taskFile(url.searchParams.get('taskId') ?? '');
            if (file === undefined) return sendJson(res, 400, { ok: false, error: 'taskId 非法' });
            try {
              // Only the record is removed — the downloaded file is kept.
              unlinkSync(file);
              return sendJson(res, 200, { ok: true });
            } catch {
              return sendJson(res, 404, { ok: false, error: '记录不存在' });
            }
          }

          return sendJson(res, 404, { ok: false, error: 'unknown route' });
        },
      }),
    'dsh-sidebar-downloads: api routes',
  );
}
