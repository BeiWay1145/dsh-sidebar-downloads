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
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(API_PREFIX + path)
  if (!res.ok) throw new Error('HTTP ' + res.status)
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
