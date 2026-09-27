# Architecture

How the BobGraph Workspace Visualizer actually works, and why it is built this way.

---

## 1. The 30-second mental model

There are **two separate JavaScript environments** and almost every oddity in this codebase
comes from that fact.

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  EXTENSION HOST             │         │  WEBVIEW (sandboxed iframe) │
│  src/extension.ts           │         │  media/webview.{html,js}    │
│  Node.js, full filesystem   │         │  browser, NO filesystem     │
│  access, can call Bob 2.0   │         │  access, strict CSP         │
└──────────┬──────────────────┘         └──────────┬──────────────────┘
           │                                       │
           │  1. injects asset URIs + CSP source   │
           │  2. acquireVsCodeApi() handle         │
           ───────────────────────────────────────►│
           │                                       │
           │  ◄──── postMessage({type:'openFile'}) │
           │  postMessage({type:'loadModel'}) ────►│
           └───────────────────────────────────────┘
```

- The **extension host** owns the panel, can read files, and will eventually call Bob 2.0.
- The **webview** owns the UI and the graph. It cannot read files. It only gets data by
  `fetch()`-ing URIs the host handed it, or by receiving `postMessage`.

---

## 2. Why asset loading is so convoluted

A webview is a sandboxed iframe. It **cannot** use `file://` paths and **cannot** resolve
relative paths like `<script src="webview.js">`. If you write that, the asset silently fails
to load and you get an unstyled, dead panel with no error message.

The fix has three parts, all in `src/extension.ts`:

**a) `asWebviewUri` converts a local file into a webview-loadable URI.**

```ts
const jsUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'webview.js')));
```

**b) `media/webview.html` is a template, not a real page.** It contains placeholders that the
host text-replaces before display:

| Placeholder in `webview.html` | Replaced with |
|---|---|
| `{{styleUri}}` | webview URI for `style.css` |
| `{{jsUri}}` | webview URI for `webview.js` |
| `${webview.cspSource}` | `panel.webview.cspSource` |

All three are replaced in one chain in `src/extension.ts`, in the function that builds the
panel HTML (search for `{{styleUri}}`).

> This document refers to code by **identifier, not line number**. Line references rot the
> moment anyone edits the file above them, and a confidently wrong line number is worse than
> no line number at all.

**c) `localResourceRoots` is the sandbox allowlist.** Only files under `media/` are reachable
at all. If you add an asset in a new folder, you must add that folder here too.

### The two globals injected into the page

```html
<script>window.MOCK_DATA_URI = "https://.../workspace-graph.json";</script>
<script>window.vscode = acquireVsCodeApi();</script>
```

- `MOCK_DATA_URI` - where the webview should fetch the workspace graph from. The webview
  cannot build this path itself because it has no idea where it is installed.
- `window.vscode` - the message handle. **`acquireVsCodeApi()` may only be called once per
  webview**, so the host grabs it and parks it on `window` for `webview.js` to use.

---

## 3. Content Security Policy, directive by directive

The CSP `meta` tag in `media/webview.html` sets one long policy. It looks scary but each
entry has a reason.

```
default-src 'none'                      <- deny everything by default
img-src      ${cspSource} https:        <- inline images + any https image
script-src   'unsafe-inline' ${cspSource} https://cdnjs.cloudflare.com https://unpkg.com
style-src    ${cspSource} 'unsafe-inline' https://fonts.googleapis.com
font-src     ${cspSource} https://fonts.gstatic.com
connect-src  ${cspSource}              <- fetch() of local JSON
```

- `${cspSource}` is substituted by the host. **If you add a new directive, use the
  placeholder, not a literal** - a literal is treated as an invalid source and silently
  dropped, which blocks your asset with no error.
- `connect-src` is what makes `fetch()` of the JSON work. Without it, `fetch` is denied by
  `default-src 'none'` and you get `TypeError: Failed to fetch`.
- The two CDN hosts are there for Cytoscape and dagre.

---

## 4. The dagre trap (this one cost real debugging time)

`dagre` layouts need **three** separate things, and a missing one fails quietly:

1. `cytoscape` (core) - from cdnjs
2. `dagre` - the standalone layout engine, from unpkg
3. `cytoscapeDagre` - the Cytoscape plugin, from unpkg

```
https://unpkg.com/dagre@0.8.5/dist/dagre.min.js          -> window.dagre
https://unpkg.com/cytoscape-dagre@2.5.0/cytoscape-dagre.js -> window.cytoscapeDagre
```

Two things bite here:

- **Load order matters.** The plugin's UMD wrapper is
  `root["cytoscapeDagre"] = factory(root["dagre"])`, so it captures `window.dagre` *at load
  time*. The `dagre` script tag must come first in `webview.html`.
- **`cytoscape.use()` takes the plugin, not the engine.** It must be
  `cytoscape.use(cytoscapeDagre)`. Passing `dagre` registers the wrong object.
- There is no `.min.js` build of the plugin. The file is at the package root.

If any of the three is missing, the `hasDagre` flag in `media/webview.js` stays `false` and
`getLayoutOptions` silently falls back to `cose` instead of throwing
`No such layout 'dagre' found`. **Check the webview console for
"Dagre layout registered"** if flowcharts look wrong.

### The node-count guard

`cose` is a physics simulation, so its cost climbs steeply with node count. Against the two
sample files it is instant; against a real workspace it can lock the webview up for minutes
with no feedback. `COSE_NODE_LIMIT` (400) caps that: past it, `getLayoutOptions` returns the
cheap `grid` layout instead and `renderWorkspaceGraph` shows a note in the node details panel
explaining the downgrade and suggesting a drill-down. Nothing is dropped - every node still
renders, just without the physics.

The count is derived from the built element list, not from `model.nodes.length`, so it stays
correct regardless of how the backend shapes the payload.

---

## 5. The data contract (`ProjectModel`)

Both views consume the same JSON shape. This is the contract with the backend.

```jsonc
{
  "nodes": [
    {
      "id": "file1",              // unique within this file
      "type": "file",             // file | class | method | function | start_end | decision
      "label": "todo-app.js",     // display label
      "filePath": "src/todo-app.js",  // used by "Open in IDE"
      "line": 1,                  // 1-based, used by "Open in IDE"
      "pseudocode": "...",        // AI summary shown in the side panel
      "flowchart": "todo-app"     // file nodes ONLY: slug of the flowchart to load
    }
  ],
  "edges": [
    { "source": "file1", "target": "file2", "relation": "imports" }
  ]
}
```

### Things that will bite you

- **`flowchart` is not optional in practice.** Clicking a `file` node loads
  `media/flowcharts/<flowchart>.json`. If it is missing, the webview falls back to the node
  `id`, so a node `id` of `file1` will 404 looking for `flowcharts/file1.json`. Keep the
  slug equal to the filename without `.json`.
- **`relation` values** map to edge styles: `contains`, `calls`, `imports`, `flow`. An
  unknown value silently gets the default grey style.
- **`line` is 1-based** in JSON. The host subtracts 1 before seeking in the editor.
- `label` becomes the Cytoscape `label`. Older Bob payloads using `name` are accepted by the
  webview for compatibility, but generated and stored graphs should use `label`.

---

## 6. Message contract

### Webview -> host

| Message | Sent by | Handled at |
|---|---|---|
| `{type:'openFile', filePath, line}` | "Open in IDE" button | `case 'openFile'` in `src/extension.ts` |

### Host -> webview

| Message | Effect |
|---|---|
| `{type:'loadModel', payload}` | Renders `payload` as the workspace graph |

`loadModel` is the seam where real data plugs in (see section 9). The host never sends it
today; the webview fetches its own data.

---

## 7. Drill-down, step by step

1. `renderWorkspaceGraph()` fetches `MOCK_DATA_URI`, then `initGraph(data, 'cose')`.
2. User clicks a node. The `cy.on('tap','node')` handler inside `initGraph()` in
   `media/webview.js` runs `showNodeDetails(data)` - the side panel fills in immediately,
   independent of drill-down.
3. If the node's `type` is `file` **and** `currentView === 'workspace'`, it calls
   `renderFlowchart(data.flowchart ?? data.id, data.label)`.
4. `renderFlowchart` shows `Loading <file>...` in the breadcrumb, fetches
   `flowcharts/<slug>.json`, then re-initialises the graph with the `dagre` layout.
5. "Back to Workspace" calls `renderWorkspaceGraph()` again.

### Why `currentView` is only set on success

`currentView` and the breadcrumb are committed **after** the fetch resolves, never before.
An earlier version set them first, which meant a failed flowchart load left the app in a
half-transitioned state: the breadcrumb said "Workspace > todo-app.js", the graph still
showed the workspace, and because `currentView` was now `'flowchart'` the
`currentView === 'workspace'` guard rejected every further click. Users experienced this as
"I have to click twice" - except the second click never worked either, and only the Back
button escaped. That guard now lives in the same `cy.on('tap','node')` handler.

The `isLoading` flag prevents overlapping loads, and `fetchModel` aborts after 5s so a hung
request cannot freeze navigation permanently.

---

## 8. Entry points and onboarding

The extension registers exactly one command, `bobgraph.openVisualizer`, shown in the
palette as **BobGraph: Open Workspace Visualizer**. `package.json` declares
`activationEvents: []` deliberately: since VS Code 1.74 a contributed command activates its
extension on demand, so no explicit activation event is needed.

Onboarding copy is contributed, not hardcoded:

| Piece | Lives in | Purpose |
|---|---|---|
| `contributes.welcomePage` | `package.json` | Short intro, auto-shown on first run |
| `contributes.walkthroughs` | `package.json` | 5-step "Get Started" guide |
| Step bodies | `media/walkthrough/*.md` | Editable copy, no rebuild required |

Two linking mechanisms tie them together:

- `[Open Workspace Visualizer](command:bobgraph.openVisualizer)` inside walkthrough
  markdown renders as a clickable button.
- `completionEvents: ["onCommand:bobgraph.openVisualizer"]` marks a step done once
  the user actually runs the command, instead of when they merely click through it.

### How the intro actually gets shown

Getting the walkthrough in front of a first-time user is more constrained than the docs
suggest. Checked against the real VS Code 1.139 manifest schema in
`workbench.desktop.main.js`, the `contributes.walkthroughs` item properties are exactly:

    id, title, icon, description, featuredFor, when, steps

**There is no `showOnStartup` property on a walkthrough.** It only exists on
`contributes.welcomePage`. Adding it to a walkthrough is silently ignored - the schema
tolerates unknown properties without warning. So the two are different things:

- `welcomePage.showOnStartup: "Walkthrough"` opens the generic **Welcome page** on first
  install, which *lists* our walkthrough among everyone else's. This is the "typical IBM
  BOB AI" experience: you are inside a shared page, not your own intro.
- Native **auto-open of our walkthrough itself** is gated on `featuredFor`, which is a list
  of glob patterns matched against workspace folder URIs. A match marks it "featured", and
  the featured walkthrough is the one opened automatically. It additionally requires the
  user setting `workbench.welcomePage.walkthroughs.openOnInstall` (default `true`).

Two consequences:

1. We set `featuredFor: ["**"]` to claim the slot for any workspace - but **the slot is
   shared**. If IBM Bob sets the same value and registered first, it wins. Do not rely on
   this.
2. It only fires on a real *install*; an extension loaded through `F5` is not installed and
   is never tracked. It is also shown once, so dismissal is permanent.

So the intro is covered three ways, in descending order of reliability:

| Mechanism | Reliability |
| --- | --- |
| First-run `showInformationMessage` in `activate()`, gated on a `globalState` flag | **Ours. Always works, including F5, and only for us** |
| `bobgraph.showGettingStarted` palette command | Always works |
| `featuredFor: ["**"]` | Best effort; may lose to another extension |

The `showInformationMessage` in `activate()` is the only one we fully own, which is why the
onboarding is a real prompt rather than a Welcome-page popup. If you see the intro twice,
check that `globalState` key `bobgraph.introSeen` is being persisted.

**Renaming a command means changing it in two places** - `contributes.commands[].command`
and the `registerCommand` string in `src/extension.ts`. They must match exactly or the
command appears in the palette and silently does nothing.

### The `media` trap - the walkthrough that refused to exist

This one cost the most time, because the failure is **invisible in the UI**. A walkthrough
step's body must be declared as `media`:

```jsonc
{
  "id": "welcome",
  "title": "Welcome",
  "description": "What this extension does.",
  "media": { "markdown": "./media/walkthrough/01-welcome.md" }   // correct
}
```

The steps were originally written with a `"content"` field, which is not in the schema. VS
Code logged this once and dropped the **entire** walkthrough:

```
ERR missing media in walkthrough step: bobgraph.gettingStarted@welcome
    at registerExtensionWalkthroughContributions
```

Nothing appears in the palette, no icon, no error on the extension itself - just one line in
the Extension Host log that is easy to miss among IBM Bob's own noise. The legitimate fields
are `id`, `title`, `description`, `media`, `contents`, `when`, `completionEvents`,
`isEventOptional` - nothing else.

`manifest.unit.test.ts` now asserts both that every step has `media` and that no step uses a
field outside that list, so the mistake cannot come back.

---

## 9. Where real data plugs in

Today the webview fetches static JSON from `media/`. For Bob 2.0 integration the data has to
come from the **extension host**, because:

- the webview has no filesystem access and cannot run the parser;
- the host is where the Bob 2.0 API call and `.bobignore` filtering belong;
- it removes the `connect-src` CSP dependency entirely.

The intended shape:

```
webview  --{type:'selectFile', filePath}-->  host
host     --{type:'loadModel', payload}---->  webview     (renderWorkspaceGraph(payload))
```

`renderWorkspaceGraph(model)` already accepts an optional model and skips `fetch()` when it
is given one, and the `loadModel` handler is already wired. So the frontend needs no
changes - only the host side does.

---

## 10. Common tasks

**Add a new node type / colour**
`nodeStyles` at the top of `media/webview.js`, then add the value to the `type` union in
section 5. Shapes: `rectangle`, `round-rectangle`, `ellipse`, `diamond`.

**Add a flowchart for a new file**
Create `media/flowcharts/<slug>.json` in the `ProjectModel` shape, then set
`"flowchart": "<slug>"` on that file's node in `workspace-graph.json`.

**Change the layout**
`getLayoutOptions()` in `media/webview.js`. `rankDir: 'TB'` is top-to-bottom; use `'LR'` for
left-to-right.

**Add a button**
Put it in `webview.html`, wire it in `media/webview.js`. The "Open in IDE" button shows the
pattern: build it with `document.createElement`, put the payload in `dataset`, and handle the
click with one delegated listener on the parent. Do not use `innerHTML` with model data or
inline `onclick` - pseudocode is model-supplied text and will break or inject markup.

**Add a host->webview message**
`postMessage` from `src/extension.ts`, then a `case` in the `window.addEventListener('message')`
handler in `media/webview.js`.

---

## 11. Known limitations

- Data is static JSON; no Bob 2.0 call yet (see section 9).
- The "Bob Agent" panel and the "Export JSON" button are **deliberately inert** until the
  backend lands. They are rendered disabled with a `title` explaining why, rather than hidden,
  so the intended feature set stays legible without inviting dead clicks. Wiring them means
  removing the `disabled` attribute in `media/webview.html` *and* adding a handler in
  `media/webview.js` - `verify-bobgraph.js` fails the build if a button is enabled with no
  listener.
- Cytoscape and dagre load from a CDN at runtime, so the panel needs network access on first
  load. Vendoring them into `media/vendor/` would remove that dependency.
- `src/test/extension.test.ts` is a placeholder assertion and covers none of the above. The
  real checks currently live in throwaway scripts under `%TEMP%\opencode\`; port them into
  `src/test/` before the project is handed over.
- There is no search or filter over nodes, and the graph is canvas-only, so it is neither
  screen-reader accessible nor keyboard navigable.

---

## 12. Theming

The panel follows the user's VS Code theme. Two rules keep that working:

1. **`media/style.css` must never redefine a `--vscode-*` variable in `:root`.** The host
   injects its own under those exact names (`--vscode-editor-background`,
   `--vscode-editor-foreground`, `--vscode-sideBar-background`, `--vscode-errorForeground`,
   `--vscode-button-*`, `--vscode-focusBorder`, ...). Defining one locally shadows the host
   and freezes the panel to a single theme. Every use is written as
   `var(--vscode-..., <hex fallback>)`; the fallback is what keeps the standalone browser
   prototype rendering dark.
2. **Cytoscape paints to a canvas and cannot read CSS custom properties**, so
   `themeColor(variable, fallback)` resolves a value from the document and passes it in as a
   concrete colour. The neutral structural edges (`contains`, `flow`) declare
   `color: null` plus a `themeVar`/`fallback` pair and are filled in at graph-build time. The
   `calls` and `imports` edges keep fixed hex on purpose - they are semantic accents, not
   theme chrome. The node type palette in `nodeStyles` is fixed for the same reason.

`themeColor` is wrapped in a try/catch on purpose: it is called during `initGraph`, and an
exception there would leave the panel blank with no error surfaced to the user.
