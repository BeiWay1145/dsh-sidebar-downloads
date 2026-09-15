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
import { api, StaleRecordError, type DownloadTask } from './api.ts'
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
    case 'paused': return '已暂停 · ' + t.percent.toFixed(1) + '%'
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
    case 'paused': return css.paused
    default: return css.active
  }
}

/**
 * Header summary. Running work wins; when nothing is running but something is
 * paused, say so rather than claiming the panel is idle — a paused 4 GB
 * transfer is not "空闲".
 */
function headerStatus(runningCount: number, tasks: DownloadTask[]): string {
  if (runningCount > 0) return runningCount + ' 个进行中'
  const paused = tasks.filter((t) => t.status === 'paused').length
  if (paused > 0) return paused + ' 个已暂停'
  return '空闲'
}

/** Work is actually happening right now (a paused task is not running). */
const isActive = (t: DownloadTask): boolean =>
  t.status === 'downloading' || t.status === 'starting' || t.status === 'probing'

/** Unfinished: kept by the "running only" filter, unlike terminal states. */
const isUnsettled = (t: DownloadTask): boolean => isActive(t) || t.status === 'paused'

export interface PanelProps {
  visible: boolean
}

export function DownloadsPanel({ visible }: PanelProps) {
  const [tasks, setTasks] = useState<DownloadTask[] | null>(null)
  // Whether the ledger directory exists. Undefined until the first response.
  const [ledgerMissing, setLedgerMissing] = useState<{ dir: string } | null>(null)
  /**
   * Transient, action-scoped notice (e.g. "that row's record is gone"). Kept
   * separate from `error` because it is informational and must not look like
   * a transport failure.
   */
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string>('')
  const [showFinished, setShowFinished] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const timer = useRef<number | undefined>(undefined)

  /**
   * Fetch the task list.
   *
   * A successful poll deliberately does NOT clear `error`: the panel polls on
   * a timer, so clearing on every success would erase a user-triggered failure
   * about a second after it appeared — the exact reason a failed action read as
   * "the button did nothing". Errors are cleared by the action that raised them
   * (or by the user dismissing them).
   */
  const refresh = useCallback(async (opts?: { clearError?: boolean }) => {
    try {
      const next = await api.tasks()
      setTasks(next.tasks)
      setLedgerMissing(next.dirExists === false ? { dir: next.dir } : null)
      if (opts?.clearError === true) setError('')
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

  // A notice is informational; clear it on its own so it cannot linger.
  useEffect(() => {
    if (notice === '') return
    const id = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(id)
  }, [notice])

  const onReveal = async (taskId: string) => {
    setBusy(taskId)
    setNotice('')
    setError('')
    try {
      await api.reveal(taskId)
    } catch (e) {
      if (e instanceof StaleRecordError) {
        // The row is obsolete: its ledger record is gone. Drop it and say so,
        // instead of surfacing an error the user cannot act on (and which,
        // rendered far from the click, reads as "the button did nothing").
        setTasks((prev) => (prev ?? []).filter((t) => t.taskId !== taskId))
        setNotice('该任务记录已不存在，已从列表移除')
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy('')
    }
  }

  const onForget = async (taskId: string) => {
    setBusy(taskId)
    setError('')
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

  // The ledger directory is gone, so there is nothing to render and nothing to
  // act on. Say that plainly rather than showing "no downloads", which reads as
  // "everything is fine" and hides the real situation.
  if (ledgerMissing !== null) {
    return (
      <div className={css.root}>
        <div className={css.header}>
          <div className={css.headline}>
            <span className={css.title}>下载</span>
            <span className={css.pill}>文件丢失</span>
          </div>
          <div className={css.headerActions}>
            <button type="button" className={css.ghostBtn} onClick={() => void refresh()} title="重新检查">
              重试
            </button>
          </div>
        </div>
        <div className={css.empty}>
          <div className={css.emptyTitle}>下载记录目录不存在</div>
          <div className={css.emptyHint}>没有可显示的任务，也无法定位文件。</div>
          <div className={css.emptyPath} title={ledgerMissing.dir}>{ledgerMissing.dir}</div>
          <div className={css.emptyHint}>
            该目录由 aria2 下载脚本首次入队时创建。若你刚清理过下载记录，这是正常的；
            否则请通过 aria2-dl.cjs（随 dsh-download-guard 分发）发起一次下载以重新建立。
          </div>
        </div>
      </div>
    )
  }

  const running = tasks.filter(isActive)
  const shown = showFinished ? tasks : tasks.filter(isUnsettled)

  return (
    <div className={css.root}>
      <div className={css.header}>
        <div className={css.headline}>
          <span className={css.title}>下载</span>
          <span className={running.length > 0 ? css.pillActive : css.pill}>{headerStatus(running.length, tasks)}</span>
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
          <button type="button" className={css.ghostBtn} onClick={() => void refresh({ clearError: true })} title="立即刷新">
            刷新
          </button>
        </div>
      </div>

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
              <div key={t.taskId} className={css.row} data-task-id={t.taskId}>
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
                    {!isUnsettled(t) && t.endedAt > 0 && new Date(t.endedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
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
                  {/* Only a settled transfer has a complete file to highlight —
                      offering this on a paused or in-flight task would send the
                      user to a partial download. */}
                  {t.status !== 'downloading' && t.status !== 'starting' &&
                   t.status !== 'probing' && t.status !== 'paused' && (
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

      {/*
        Action feedback lives here rather than above the list: the list scrolls,
        and an error rendered above it was scrolled out of view — which is why a
        failed action read as "the button did nothing". Anchored to the bottom
        edge so it is visible regardless of scroll position.
      */}
      {(notice !== '' || error !== '') && (
        <div className={css.toastArea}>
          {notice !== '' && (
            <div className={css.notice} role="status" onClick={() => setNotice('')}>
              {notice}
            </div>
          )}
          {error !== '' && (
            <div className={css.errorBar} role="alert" onClick={() => setError('')}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
