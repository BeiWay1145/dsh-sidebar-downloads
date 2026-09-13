/**
 * dsh-sidebar-downloads — host half.
 *
 * Reads the download task ledger written by dsh-download-progress'
 * `download.cjs` (`~/.dsh/downloads/tasks/*.json`, one file per task) and
 * republishes it over HTTP for the client half, plus the two file actions
 * the panel offers (reveal in Explorer / forget a record).
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
}

const HOME = homedir();
const TASKS_DIR = join(HOME, '.dsh', 'downloads', 'tasks');

/** Route prefix; the client half mirrors these paths. */
export const API_PREFIX = '/api/sidebar-downloads';

/** cordis inject declaration — the only service this half depends on. */
export const inject = ['webServer'];

/** Statuses that mean "work is happening right now". */
const ACTIVE = new Set(['downloading', 'starting', 'probing']);

/**
 * Read every task record. A malformed or half-written JSON file is skipped
 * rather than failing the whole listing — download.cjs rewrites these files
 * on a 500 ms tick, so a torn read is expected and must never surface as an
 * error to the panel.
 */
function readTasks(): TaskRecord[] {
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
      const obj = JSON.parse(readFileSync(join(TASKS_DIR, name), 'utf8'));
      if (!obj || typeof obj !== 'object' || !obj.name) continue;
      tasks.push({
        taskId,
        name: obj.name,
        url: obj.url ?? '',
        finalUrl: obj.finalUrl ?? '',
        outPath: obj.outPath ?? '',
        status: obj.status ?? 'unknown',
        error: obj.error ?? '',
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
      });
    } catch {
      /* torn or malformed record — skip */
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
            const tasks = readTasks();
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
