# dsh-sidebar-downloads

A [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) satellite plugin that shows **aria2 download progress in the sidebar**.

> This plugin is the **sidebar view of the aria2 download channel**: it reads the ledger `aria2-dl.js` writes (`~/.dsh/downloads/tasks/*.json`) and refreshes records carrying a `gid` from the aria2 RPC. It implements no downloader of its own — it just renders the real state as a sidebar page.
>
> It pairs with [dsh-download-guard](https://github.com/BeiWay1145/dsh-download-guard), which forces every download through aria2. Together they close the loop: **the guard owns "this is the only way", this plugin owns "you can see it".**

## Why

Download progress used to live in a bottom-right overlay that covers conversation content, has to be dragged out of the way, and sits apart from DSH's own sidebar system. This plugin registers a proper better-sidebar page — a peer of Explorer / Terminal / Git — so opening, moving, splitting and theming are all handled by the host.

## Features

| | |
|---|---|
| **Live progress** | Progress bar and percentage, colour-coded by state (running / done / failed / cancelled) |
| **Speed and ETA** | MB/s and remaining time, shown while a transfer is running |
| **Unknown-size downloads** | A pulsing bar when the server sends no `Content-Length`, instead of a fabricated percentage |
| **History** | Finished and failed tasks stay listed; toggle "running only" |
| **True byte counts** | Size-less tasks fall back to the **actual file size on disk**, so a killed process never reports a wrong number |
| **Live aria2 correction** | Records carrying a `gid` are refreshed from the aria2 RPC, so even a stale `--no-wait` record shows real progress and speed |
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

The plugin reads the `~/.dsh/downloads/tasks/<taskId>.json` ledger (one JSON file per download) and **fetches nothing, writes nothing**.

### One producer: `aria2-dl.js`

The ledger now has exactly **one** writer — the `aria2-download` skill's `aria2-dl.js`, which records a `gid` on every enqueue. With [dsh-download-guard](https://github.com/BeiWay1145/dsh-download-guard) denying anything that would bypass aria2, that ledger is the **complete** record of download activity.

### Why the aria2 RPC is still consulted

With `--no-wait` — the normal way an agent starts a big download — `aria2-dl.js` writes its record **once**, at enqueue time (`status: starting`, all-zero counters), and never updates it while the transfer runs on. Reading that file naively leaves the panel at 0% forever, or prints the impossible "3.62 GB / 0.00 GB".

So for **any record carrying a `gid`, this plugin queries the aria2 RPC directly** (`127.0.0.1:16800`, Motrix Next's bundled engine) and reports the engine's actual state. When the engine is not running it degrades to "show what the ledger says" — never to an error.

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
npm test           # host/client smoke tests + panel DOM integration test
```

Artifacts under `lib/` are committed — that is the convention in this ecosystem, so installing from git needs no build step.

## License

MIT
