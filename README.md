# dsh-sidebar-downloads

把下载进度**从悬浮窗搬进侧边栏**的 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 附属插件。

> 本插件是 [dsh-download-progress](https://github.com/omdsh-dev/DSH-better-sidebar) 悬浮面板的替代显示层：**复用它的任务账本**（`~/.dsh/downloads/tasks/*.json`），不重复实现下载器，只是把同样的数据渲染成一个侧边栏页面。

## 为什么

原 `dsh-download-progress` 用一个右下角悬浮窗展示进度。悬浮窗会**盖住会话内容**、要手动拖拽躲避、且和 DSH 自身的侧边栏体系割裂。本插件注册一个正式的 better-sidebar 页面——和「资源管理器 / 终端 / Git」并列，开合、拆并、皮肤跟随全部由底座统一管理。

## 功能

| | |
|---|---|
| **实时进度** | 进度条 + 百分比，按状态着色（进行中 / 完成 / 失败 / 已取消） |
| **速度与剩余时间** | MB/s 与 ETA，仅在任务进行中显示 |
| **未知大小的下载** | 服务器不返回 `Content-Length` 时显示脉冲条，而不是伪造一个百分比 |
| **历史记录** | 完成 / 失败的任务保留在列表里，可切换「只看进行中」 |
| **字节数取真实磁盘值** | 进行中的任务以**磁盘实际大小**为准，进程被杀掉也不会显示错数字 |
| **在文件夹中显示** | 一键在资源管理器中定位已下载文件 |
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

本插件读取 `dsh-download-progress` 写入的任务账本：

```
~/.dsh/downloads/tasks/<taskId>.json
```

每个下载任务一个 JSON 文件，包含 `name / status / total / downloaded / percent / speedMBps / etaSec / outPath` 等字段。因此：

- **下载器仍是 `dsh-download-progress` 的 `download.cjs`**——本插件不抓取网络、不写文件。
- 两个插件可以**同时安装**：悬浮窗与侧边栏页面读同一份数据，显示内容一致。
- 若你只想用侧边栏，可以在 better-sidebar 设置页里关掉不下需要的 tab；悬浮窗若要去掉，卸载 `dsh-download-progress` 会同时失去下载任务写入方，此时本插件会显示「暂无下载任务」。

## 架构

```
src/index.ts               host 半：读任务账本 → HTTP 路由（/tasks、/reveal、/forget）
src/client/index.tsx       client 半：注册一个 better-sidebar tab
src/client/DownloadsPanel.tsx   tab 内容：轮询、渲染、交互
src/client/panel.module.css     样式：全部走 --dsw-alias-* 令牌，跟随皮肤
src/client/api.ts         typed fetch 封装
scripts/build.mjs         构建：esbuild + lightningcss
```

**host 半** 只声明 `inject: ['webServer']`，用 node 内置模块读写文件，不依赖 `ctx.fs` / `ctx.subprocess`。
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
npm test           # host 半 + client 半冒烟测试
```

`lib/` 下的产物是提交进仓库的——这是本生态的约定，让用户从 git 安装时无需构建步骤。

## 许可

MIT
