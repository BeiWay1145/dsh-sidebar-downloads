# dsh-sidebar-downloads

A [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) satellite plugin that moves download progress **out of a floating overlay and into the sidebar**.

> This plugin is an alternative display layer for the `dsh-download-progress` overlay: it **reuses that plugin's task ledger** (`~/.dsh/downloads/tasks/*.json`) rather than implementing a second downloader.

## Why

The original overlay sits in the bottom-right corner, covers conversation content, has to be dragged out of the way, and is disconnected from DSH's own sidebar system. This plugin registers a proper better-sidebar page — a peer of Explorer / Terminal / Git — so opening, moving, splitting and theming are all handled by the host.

## Features

| | |
|---|---|
| **Live progress** | Progress bar and percentage, colour-coded by state (running / done / failed / cancelled) |
| **Speed and ETA** | MB/s and remaining time, shown while a transfer is running |
| **Unknown-size downloads** | A pulsing bar when the server sends no `Content-Length`, instead of a fabricated percentage |
| **History** | Finished and failed tasks stay listed; toggle "running only" |
| **True byte counts** | Live rows read the **actual file size on disk**, so a killed process never reports a wrong number |
| **Reveal in folder** | Locate a finished file in Explorer in one click |
| **Forget record** | Deletes only the ledger entry — **the downloaded file is kept** |
| **Expandable detail** | Click a row for output path, source URL, elapsed time and error text |

## Install

Requires [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (≥ 0.19.0).

```bash
cd ~/.dsh && dsh plugin --profile <your-profile> add dsh-better-sidebar && dsh plugin --profile <your-profile> add "dsh-sidebar-downloads@github:BeiWay1145/dsh-sidebar-downloads"
```

**Restart DSH**, then open the sidebar's `+` menu and pick "下载" (Downloads).

Build artifacts are committed, so **no local build step is needed**.

## Data source

The plugin reads the task ledger written by `dsh-download-progress`:

```
~/.dsh/downloads/tasks/<taskId>.json
```

One JSON file per download, carrying `name / status / total / downloaded / percent / speedMBps / etaSec / outPath` and friends. Consequently:

- **The downloader stays `dsh-download-progress`'s `download.cjs`** — this plugin fetches nothing and writes no files.
- Both plugins can be **installed side by side**: the overlay and the sidebar page read the same data and agree.
- If you remove `dsh-download-progress`, you also remove the producer that writes the ledger, and this plugin will simply show "暂无下载任务" (no tasks).

## Architecture

```
src/index.ts                    host half: ledger -> HTTP routes (/tasks, /reveal, /forget)
src/client/index.tsx            client half: registers one better-sidebar tab
src/client/DownloadsPanel.tsx   tab body: polling, rendering, interaction
src/client/panel.module.css     styles: --dsw-alias-* tokens only, follows every skin
src/client/api.ts               typed fetch wrapper
scripts/build.mjs               build: esbuild + lightningcss
```

The **host half** declares only `inject: ['webServer']` and uses node built-ins for file access, so it depends on neither `ctx.fs` nor `ctx.subprocess`.
The **client half** only registers (`ctx.betterSidebar.registerTab`) and owns no layout of its own — uninstalling it leaves nothing behind.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sidebar-downloads/tasks` | All tasks (running first) |
| GET | `/api/sidebar-downloads/reveal?taskId=` | Reveal the output file in Explorer |
| GET | `/api/sidebar-downloads/forget?taskId=` | Drop one ledger record (keeps the file) |

`taskId` is validated to reject path separators and `..`, so a crafted query cannot escape the tasks directory.

## Development

```bash
npm install
npm run build      # emits lib/index.js and lib/client.js
npm run typecheck
npm test           # host-half and client-half smoke tests
```

Artifacts under `lib/` are committed — that is the convention in this ecosystem, so installing from git needs no build step.

## License

MIT
