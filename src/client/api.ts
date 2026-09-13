/**
 * Typed client for the host half's routes. Kept free of React so it can be
 * imported by tests directly.
 */
export const API_PREFIX = '/api/sidebar-downloads'

/** One task record, mirroring the host half's normalized shape. */
export interface DownloadTask {
  taskId: string
  name: string
  url: string
  finalUrl: string
  outPath: string
  /**
   * One of: downloading | starting | probing | paused | done | error |
   * cancelled | unknown. `paused` is unfinished but not running, so it is
   * excluded from the running count while staying in the running-only filter.
   */
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
  /** Bytes currently on disk for outPath (authoritative for live rows). */
  bytesOnDisk: number
}

export interface TasksResponse {
  ok: boolean
  tasks: DownloadTask[]
  active: number
  /** False when the ledger directory itself is missing (never written / deleted). */
  dirExists: boolean
  /** The ledger directory path, for the panel's message. */
  dir: string
}

/** Thrown when a record referenced by a rendered row no longer exists. */
export class StaleRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleRecordError'
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API_PREFIX + path)
  if (!res.ok) {
    // A 404 carrying `stale: true` means the row is obsolete, not that the
    // request failed — the panel acts on that distinction.
    let stale = false
    let message = 'HTTP ' + res.status
    try {
      const body = (await res.json()) as { error?: string; stale?: boolean }
      if (typeof body.error === 'string' && body.error !== '') message = body.error
      stale = body.stale === true
    } catch {
      /* body was not JSON; keep the status message */
    }
    if (stale) throw new StaleRecordError(message)
    throw new Error(message)
  }
  const data = (await res.json()) as T & { error?: string }
  if (data && typeof data === 'object' && 'ok' in data && data.ok === false) {
    throw new Error(data.error ?? '请求失败')
  }
  return data
}

export const api = {
  tasks: (): Promise<TasksResponse> => getJson<TasksResponse>('/tasks'),
  reveal: (taskId: string): Promise<{ ok: boolean }> =>
    getJson<{ ok: boolean }>('/reveal?taskId=' + encodeURIComponent(taskId)),
  /** Remove the ledger record only; the downloaded file itself is kept. */
  forget: (taskId: string): Promise<{ ok: boolean }> =>
    getJson<{ ok: boolean }>('/forget?taskId=' + encodeURIComponent(taskId)),
}
