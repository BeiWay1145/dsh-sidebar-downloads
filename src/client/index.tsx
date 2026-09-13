/**
 * dsh-sidebar-downloads — client half.
 *
 * Registers exactly one better-sidebar tab ("下载") that renders the live
 * download list. The tab is inactive until `ctx.betterSidebar` exists, which
 * is why `betterSidebar` is declared in `inject`: cordis only re-evaluates
 * this plugin once the service is published, and reading an undeclared
 * service off ctx throws.
 *
 * This half deliberately owns no layout of its own — it is a pure
 * registration onto the host's sidebar, so uninstalling it leaves nothing
 * behind.
 */
import { DownloadsPanel } from './DownloadsPanel.tsx'
import { inject } from './inject.ts'

export { inject }

/** Download glyph: an arrow into a tray. Monochrome via currentColor so the
 *  host's tab chip colors it like every built-in tab. */
function DownloadsIcon(size: number) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v7m0 0L5.2 6.2M8 9l2.8-2.8M2.6 11.2v1.4a1.4 1.4 0 0 0 1.4 1.4h8a1.4 1.4 0 0 0 1.4-1.4v-1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function apply(ctx: any): void {
  ctx.effect(
    () =>
      ctx.betterSidebar.registerTab({
        id: 'dsh-sidebar-downloads',
        title: () => '下载',
        description: () => '下载任务的实时进度：速度、剩余时间与历史记录',
        icon: (size: number) => DownloadsIcon(size),
        // Sits just after the built-in file/changes tabs and before
        // session-scoped extras.
        order: 30,
        // One list for the whole app: focusing an existing tab is right,
        // opening a second copy is not.
        single: true,
        component: (props: { visible: boolean }) => <DownloadsPanel visible={props.visible} />,
      }),
    'dsh-sidebar-downloads: register sidebar tab',
  )
}
