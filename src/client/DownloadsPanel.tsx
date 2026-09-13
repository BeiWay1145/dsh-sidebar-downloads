/**
 * The sidebar tab body: a live download list.
 *
 * Design constraints this component works under:
 * - The native right-Sidebar tab body is a block scroll container with a
 *   definite height (not a flex container), so the root must be
 *   `height: 100%` and own its own scrolling.
 * - Colors come from DSH's \`--dsw-alias-*\` tokens so every skin (light /
 *   dark / custom) is covered without a per-skin branch.
 * - Polling only runs while the tab is `visible`; a backgrounded tab costs
 *   nothing. The cadence is faster while a download is active.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type DownloadTask } from './api.ts'
import css from './panel.module.css'

/** Human-readable byte size. */
function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i]
}

function fmtSpeed(mbps: number): string {
  if (!mbps || mbps <= 0) return ''
  return mbps >= 10 ? mbps.toFixed(1) + ' MB/s' : mbps.toFixed(2) + ' MB/s'
}

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return ''
  const s = Math.round(sec)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
}

function statusLabel(t: DownloadTask): string {
  switch (t.status) {
    case 'done': return '已完成'
    case 'error': return '失败'
    case 'cancelled': return '已取消'
    case 'probing': return '探测中'
    case 'starting': return '准备中'
    default: return t.percent > 0 ? t.percent.toFixed(1) + '%' : '下载中'
  }
}

/** Per-status accent, drawn from the token palette. */
function statusClass(t: DownloadTask): string {
  switch (t.status) {
    case 'done': return css.done
    case 'error': return css.error
    case 'cancelled': return css.cancelled
    default: return css.active
  }
}

const isActive = (t: DownloadTask): boolean =>
  t.status === 'downloading' || t.status === 'starting' || t.status === 'probing'

export interface PanelProps {
  visible: boolean
}

export function DownloadsPanel({ visible }: PanelProps) {
  const [tasks, setTasks] = useState<DownloadTask[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string>('')
  const [showFinished, setShowFinished] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const timer = useRef<number | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const next = await api.tasks()
      setTasks(next.tasks)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // Poll only while visible. Cadence tightens while something is running so
  // the bar and speed readout stay live, and relaxes when everything is
  // terminal — an idle panel is nearly free.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let handle: number | undefined

    const tick = async () => {
      if (cancelled) return
      await refresh()
      if (cancelled) return
      const running = (tasks ?? []).some(isActive)
      handle = window.setTimeout(tick, running ? 700 : 3000)
      timer.current = handle
    }
    void tick()

    return () => {
      cancelled = true
      if (handle !== undefined) window.clearTimeout(handle)
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
    // `tasks` is intentionally read through the closure each tick: the cadence
    // decision is made from the freshest data, and re-subscribing on every
    // poll would restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, refresh])

  const onReveal = async (taskId: string) => {
    setBusy(taskId)
    try {
      await api.reveal(taskId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const onForget = async (taskId: string) => {
    setBusy(taskId)
    try {
      await api.forget(taskId)
      // Drop it locally as well so the row disappears immediately instead of
      // waiting for the next poll.
      setTasks((prev) => (prev ?? []).filter((t) => t.taskId !== taskId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const toggle = (taskId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  if (tasks === null) {
    return (
      <div className={css.root}>
        <div className={css.empty}>载入中…</div>
      </div>
    )
  }

  const running = tasks.filter(isActive)
  const finished = tasks.filter((t) => !isActive(t))
  const shown = showFinished ? tasks : running

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.headline}>
          <span className={css.title}>下载</span>
          <span className={running.length > 0 ? css.pillActive : css.pill}>
            {running.length > 0 ? running.length + ' 个进行中' : '空闲'}
          </span>
        </div>
        <div className={css.headerActions}>
          <button
            type="button"
            className={css.ghostBtn}
            onClick={() => setShowFinished((v) => !v)}
            title={showFinished ? '只看进行中的任务' : '显示全部任务'}
          >
            {showFinished ? '只看进行中' : '显示全部'}
          </button>
          <button type="button" className={css.ghostBtn} onClick={() => void refresh()} title="立即刷新">
            刷新
          </button>
        </div>
      </div>

      {error !== '' && <div className={css.errorBar}>{error}</div>}

      <div className={css.list}>
        {shown.length === 0 ? (
          <div className={css.empty}>
            {tasks.length === 0
              ? '暂无下载任务'
              : '没有进行中的下载 — 切到「显示全部」查看历史记录'}
          </div>
        ) : (
          shown.map((t) => {
            const active = isActive(t)
            // Prefer the live byte count; fall back to the record's own
            // downloaded total for terminal rows.
            const bytes = active && t.bytesOnDisk > 0 ? t.bytesOnDisk : t.downloaded
            const pct = t.total > 0 ? Math.min(100, Math.max(0, (bytes / t.total) * 100)) : (t.percent > 0 ? t.percent : 0)
            const unknownSize = t.total <= 0
            const isOpen = expanded.has(t.taskId)
            return (
              <div key={t.taskId} className={css.row}>
                <div className={css.rowHead} onClick={() => toggle(t.taskId)} role="button" tabIndex={0}
                     onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(t.taskId) } }}>
                  <span className={isOpen ? css.chevronOpen : css.chevron} aria-hidden="true">›</span>
                  <span className={css.name} title={t.name}>{t.name}</span>
                  <span className={statusClass(t) + ' ' + css.status}>{statusLabel(t)}</span>
                </div>

                <div className={css.bar} aria-hidden="true">
                  <div
                    className={statusClass(t) + ' ' + css.fill}
                    style={{ width: (unknownSize && active ? 100 : pct) + '%' }}
                    data-indeterminate={unknownSize && active ? 'true' : undefined}
                  />
                </div>

                <div className={css.meta}>
                  <span>
                    {fmtBytes(bytes)}
                    {!unknownSize && ' / ' + fmtBytes(t.total)}
                  </span>
                  <span className={css.metaRight}>
                    {active && fmtSpeed(t.speedMBps)}
                    {active && t.etaSec > 0 && ' · 剩余 ' + fmtDuration(t.etaSec)}
                    {!active && t.endedAt > 0 && new Date(t.endedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>

                {isOpen && (
                  <div className={css.detail}>
                    {t.outPath && (
                      <div className={css.detailRow}>
                        <span className={css.detailKey}>路径</span>
                        <span className={css.detailVal} title={t.outPath}>{t.outPath}</span>
                      </div>
                    )}
                    {(t.finalUrl || t.url) && (
                      <div className={css.detailRow}>
                        <span className={css.detailKey}>来源</span>
                        <span className={css.detailVal} title={t.finalUrl || t.url}>{t.finalUrl || t.url}</span>
                      </div>
                    )}
                    {t.elapsedSec > 0 && (
                      <div className={css.detailRow}>
                        <span className={css.detailKey}>耗时</span>
                        <span className={css.detailVal}>{fmtDuration(t.elapsedSec)}</span>
                      </div>
                    )}
                    {t.error !== '' && (
                      <div className={css.detailRow}>
                        <span className={css.detailKey}>错误</span>
                        <span className={css.detailVal + ' ' + css.errorText}>{t.error}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className={css.actions}>
                  {!active && (
                    <button type="button" className={css.actBtn} disabled={busy === t.taskId}
                            onClick={() => void onReveal(t.taskId)}>
                      在文件夹中显示
                    </button>
                  )}
                  <button type="button" className={css.actBtnDanger} disabled={busy === t.taskId}
                          onClick={() => void onForget(t.taskId)} title="只移除这条记录，已下载的文件会保留">
                    移除记录
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
