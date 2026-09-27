# Backend Handoff

What the frontend team has finished, what the backend team must supply, and the exact
contract between them. Read this before writing the Bob 2.0 integration.

---

## 1. Where things stand

The extension is feature-complete against **bundled sample data**. The panel renders a
workspace graph, drills into per-file flowcharts, shows pseudocode, and jumps to source. It
packages to an installable `.vsix`.

What is **not** done is the actual Bob 2.0 call. Today the webview fetches static JSON from
`media/`. Nothing invokes a Bob CLI, reads a `.bob` file, or runs any analysis.

| Area | State |
| --- | --- |
| Panel, graph, drill-down, pseudocode, Open in IDE | Done, tested |
| Theming (light/dark/high contrast) | Done |
| Model validation and error surfacing | Done |
| Walkthrough onboarding | Done |
| Unit tests (`npm test`) + host test | Done, currently 62 unit tests |
| `vsce package` producing an installable `.vsix` | Done |
| **Bob 2.0 invocation** | **Not started - this is the backend's job** |
| **Bob Agent chat panel** | **Stubbed, disabled on purpose** |
| **Export JSON** | **Stubbed, disabled on purpose** |

---

## 2. The contract you must produce

The webview reads one JSON shape, from two places.

### 2.1 Workspace graph

Fetched from `media/workspace-graph.json` (overridable - see section 4).

```jsonc
{
  "nodes": [
    {
      "id": "file1",                    // REQUIRED, unique. Used for edge refs and the flowchart slug.
      "name": "todo-app.js",            // REQUIRED. This is the label drawn on the node.
      "type": "file",                   // See the allowed list in 2.3.
      "filePath": "src/todo-app.js",    // Used by "Open in IDE".
      "line": 1,                        // Line for "Open in IDE".
      "pseudocode": "AI summary...",    // Shown in the right panel.
      "flowchart": "todo-app"           // Slug: loads flowcharts/<slug>.json on click.
    }
  ],
  "edges": [
    { "source": "file1", "target": "file2", "relation": "imports" }
  ]
}
```

### 2.2 Per-file flowchart

Fetched as `flowcharts/<flowchart slug>.json`. **Identical shape** to the workspace graph -
same `nodes`/`edges`, but the nodes are statements rather than files.

### 2.3 Field names that will bite you

| Field | Note |
| --- | --- |
| `name`, not `label` | The model says `name`; Cytoscape's own field is `label`. Mixing them up renders every node blank. We detect it and warn, but fix it at the source. |
| `id` must be unique | Duplicates are silently merged by Cytoscape, so a file can vanish with no error. We detect and warn. |
| `edge.source` / `edge.target` must exist in `nodes` | A dangling reference makes Cytoscape **throw**, which kills the whole graph. We drop such edges and warn. |
| `flowchart` should be a bare slug | `flowcharts/<slug>.json`. If omitted, the node `id` is used as the slug, so an `id` like `src/deep/file.js` produces a 404 on click. |
| `type` must be one of the known values | `file`, `class`, `method`, `function`, `start_end`, `decision`. Unknown types still draw but with no colour or shape. |

### 2.4 What we do with bad data

We do **not** trust the producer. `sanitizeModel()` in `media/webview.js` coerces
`nodes`/`edges` to arrays, drops duplicate ids, drops edges with missing endpoints, fills in
missing labels, and flags unrecognised types. Anything it repairs is listed in the Node
Details panel and logged to the webview console.

This means **a malformed model degrades the graph instead of blanking the panel**, and you
get a list of what was wrong rather than a stack trace. Verified against Cytoscape 3.26.0
directly: without this, one bad edge reference throws
`Can not create edge ... with nonexistant target`.

---

## 3. Error and edge-case behaviour you can rely on

| Situation | What the user sees |
| --- | --- |
| Fetch fails / times out (5s) | Error text plus a **Retry** button |
| Model malformed | Repaired graph plus a list of problems |
| Graph empty | "the model contained no nodes, so there is nothing to draw" |
| Over 400 nodes | Grid layout instead of the slow physics layout, with a note |
| `dagre` CDN unreachable | Falls back to `cose` automatically |
| A drill-down fails | Stays on the workspace view; clicking the node again retries |
| Clicking a node while loading | Ignored, no wedged state |

---

## 4. How to hand data to the frontend

Today the webview does:

```js
const raw = await fetchModel(window.MOCK_DATA_URI || 'workspace-graph.json', 'workspace graph');
```

Three integration options, cheapest first:

1. **Static files.** Write real output to `media/workspace-graph.json` and
   `media/flowcharts/*.json`. Zero code. Good enough for a demo.
2. **Post a message from the host.** `src/extension.ts` already accepts
   `renderWorkspaceGraph(message.payload)` from the host, so a Bob 2.0 run can push a model
   straight into the panel with no file at all. This is the intended path for live data.
3. **A `bob` shell-out in the host.** `src/extension.ts` runs the analysis and pushes the
   result via option 2. Needs a decision on which binary/flags, and error handling for a
   missing CLI.

Option 2 is the smallest change with the largest payoff. Whatever you pick, keep producing
the shape in section 2 and nothing in the frontend needs to change.

---

## 5. Open frontend work, in priority order

1. **Search / filter over nodes.** The first thing that will hurt. Fine with 2 files,
   unusable with 200 nodes. This is the top item.
2. **Accessibility.** Cytoscape draws to a canvas, so the graph is invisible to screen
   readers and untabbable. Needs a keyboard-reachable file list beside the graph.
3. **Scale testing.** The 400-node guard is a guess. It should be measured against a real
   large repository, and the threshold tuned.
4. **Diffing / "what changed".** Compare two runs of the graph. Not started; scope unknown.
5. **Empty and error states for the agent panel**, once the backend has an endpoint.

---

## 6. Known limitations to be honest about

- **CDN dependency.** Cytoscape and dagre load from unpkg/cdnjs at runtime, so the panel
  needs network access on first load. Vendoring into `media/vendor/` would remove this.
- **No test coverage of the real Bob 2.0 output**, because none exists yet. The moment you
  produce a real model, run it past `sanitizeModel` - the warnings list is your checklist.
- **`repository` is absent** from `package.json`. `vsce package` warns, but the Marketplace
  requires it. Add the real URL once the repo exists.
- **`publisher` is a placeholder**, `bob-ai-team`. Change it before publishing; it becomes
  part of the public extension id and is awkward to change later.
- **The icon is unverified.** `media/icon.png` is 128x128 and generated, but nobody has
  eyeballed it. Check it before shipping.
- **There are two `webview.js` files on this machine.** A stale prototype lives at
  `../BobGraph-The-WorkSpace-Visualizer/`, outside this repository. It is an earlier version
  missing roughly ten fixes - notably `sanitizeModel()`, so real Bob 2.0 data would blank its
  panel. It has a `README.md` saying so. Ignore it; work in this folder.

---

## 7. Verification you can run

```bash
npm install
npm test                      # unit tests: under a second, no downloads
npm run pretest               # compile + lint
npx @vscode/vsce package      # -> bobgraph-0.0.1.vsix
```

`npm test` prints its own count, so trust that over any number written in these docs.

`npm run test:integration` additionally needs a VS Code download.

The suite is mutation-verified: nine deliberate regressions, including an unreachable
`cy.on('tap')` that silently killed every node click, and a bypassed `sanitizeModel`. All
nine are caught. If you change `media/webview.js`, run `npm test` before you trust it.

## 8. Reading order

- `ARCHITECTURE.md` - how it all works, and the traps (dagre load order, the `media`
  walkthrough field, the theming rules, the data contract)
- `README.md` - setup and layout
- `media/webview.js` - all frontend logic; start at `sanitizeModel`
