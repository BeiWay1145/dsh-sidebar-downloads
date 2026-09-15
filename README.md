# dsh-sidebar-downloads

把 **aria2 下载进度显示在侧边栏**的 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 附属插件。

> 本插件是 **aria2 下载通道的侧边栏视图**：读取 `aria2-dl.js` 写的任务账本（`~/.dsh/downloads/tasks/*.json`），并对**带 `gid` 的记录查询 aria2 RPC 补正**，不重复实现下载器，只把真实状态渲染成一个侧边栏页面。
>
> 配套 [dsh-download-guard](https://github.com/BeiWay1145/dsh-download-guard) 强制所有下载走 aria2 —— 两者合起来是完整闭环：**守卫负责「只能走这条路」，本插件负责「能看见这条路」**。

## 为什么

下载进度曾经由右下角悬浮窗展示：会**盖住会话内容**、要手动拖拽躲避、且和 DSH 自身的侧边栏体系割裂。本插件注册一个正式的 better-sidebar 页面——和「资源管理器 / 终端 / Git」并列，开合、拆并、皮肤跟随全部由底座统一管理。

## 功能

| | |
|---|---|
| **实时进度** | 进度条 + 百分比，按状态着色（进行中 / 完成 / 失败 / 已取消） |
| **速度与剩余时间** | MB/s 与 ETA，仅在任务进行中显示 |
| **未知大小的下载** | 服务器不返回 `Content-Length` 时显示脉冲条，而不是伪造一个百分比 |
| **历史记录** | 完成 / 失败的任务保留在列表里，可切换「只看进行中」 |
| **字节数取真实磁盘值** | 无宽度信息的任务以磁盘实际大小为准，进程被杀掉也不会显示错数字 |
| **aria2 实时补正** | 带 `gid` 的任务直接查 aria2 RPC，`--no-wait` 入队的陈旧记录也能显示真实进度与速度 |
| **暂停状态** | 手动暂停的任务显示「已暂停 · 百分比」并以琥珀色区分，计入「N 个已暂停」而非「进行中」；不显示完成时间，也不提供「在文件夹中显示」（文件尚未完整） |
| **在文件夹中显示** | 一键在资源管理器中定位已下载文件 |
| **操作反馈常驻可见** | 失败/提示锚定在面板底部浮层，不会被列表滚动带走；点击即可关闭 |
| **记录失效自动清理** | 记录已被删除时（例如清理过账本），点击会移除该行并说明原因，而不是静默失败 |
| **账本缺失明确提示** | 下载记录目录不存在时显示「文件丢失」与具体路径，而不是伪装成「暂无任务」 |
| **移除记录** | 只删除账本记录，**已下载的文件保留** |
| **详情展开** | 点击任意任务行展开：输出路径、来源 URL、耗时、错误信息 |

## 安装

前置：已安装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（≥ 0.19.0）。

```bash
cd ~/.dsh && dsh plugin --profile <your-profile> add dsh-better-sidebar && dsh plugin --profile <your-profile> add "dsh-sidebar-downloads@github:BeiWay1145/dsh-sidebar-downloads"
```

安装后**重启 DSH**，然后点侧边栏的 `+` 菜单，选择「下载」。

构建产物已随仓库提交，**无需在本地编译**。

## 数据来源

本插件读取 `~/.dsh/downloads/tasks/<taskId>.json` 任务账本（每个下载任务一个 JSON 文件），**不抓取网络、不写文件**。

### 唯一的生产者：`aria2-dl.js`

账本现在只有 **一个** 写入方——`aria2-dl.cjs`（随 [dsh-download-guard](https://github.com/BeiWay1145/dsh-download-guard) 包分发）。每次入队都会写一条带 `gid` 字段的记录。配合守卫拦掉一切绕过 aria2 的命令后，这个账本即**全部**的下载活动。

### 为什么还要查 aria2 RPC

`aria2-dl.js` 以 `--no-wait` 方式入队时，只在**入队瞬间写一次**记录（`status: starting`、计数器全 0）就返回，之后不再更新——而下载其实还在跑。直接读该文件会让面板永远停在 0%，甚至显示「已下载 3.62 GB / 总量 0.00 GB」这种自相矛盾的结果。

因此本插件对**带 `gid` 的记录会直接查询 aria2 RPC**（`127.0.0.1:16800`，Motrix Next 内置引擎），以引擎的实际状态为准。引擎未运行时自动降级为「照账本显示」，不会报错。

## 架构

```
src/index.ts               host 半：读任务账本 → HTTP 路由（/tasks、/reveal、/forget）
src/client/index.tsx       client 半：注册一个 better-sidebar tab
src/client/DownloadsPanel.tsx   tab 内容：轮询、渲染、交互
src/client/panel.module.css     样式：全部走 --dsw-alias-* 令牌，跟随皮肤
src/client/api.ts         typed fetch 封装
scripts/build.mjs         构建：esbuild + lightningcss
```

**host 半** 只声明 `inject: ['webServer']`，用 node 内置模块读写文件，不依赖 `ctx.fs` / `ctx.subprocess`；查询 aria2 RPC 用的是 node 内置 `fetch`，无额外依赖。
**client 半** 只做注册（`ctx.betterSidebar.registerTab`），不自行布局，卸载后零残留。

### 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sidebar-downloads/tasks` | 全部任务（进行中优先，最多最近若干条） |
| GET | `/api/sidebar-downloads/reveal?taskId=` | 在资源管理器中定位输出文件 |
| GET | `/api/sidebar-downloads/forget?taskId=` | 删除一条账本记录（不删文件） |

`taskId` 会校验，拒绝任何含路径分隔符或 `..` 的输入，无法越出任务目录。

## 开发

```bash
npm install
npm run build      # 产出 lib/index.js 与 lib/client.js
npm run typecheck
npm test           # host 半 + client 半冒烟测试 + panel DOM 集成测试
```

`lib/` 下的产物是提交进仓库的——这是本生态的约定，让用户从 git 安装时无需构建步骤。

## 许可

MIT
