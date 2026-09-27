# BobGraph — Workspace Visualizer

> **Turn any codebase into a navigable graph.** BobGraph renders your project as an interactive dependency map, lets you drill into any file's internal flowchart, and puts an AI-written plain-language summary of any node one click away — so you spend less time reading files and more time understanding the code.

---

## Quick start

### Install

Install from the VS Code Marketplace — search **BobGraph** or use the `.vsix` directly:

```
Extensions panel → ⋯ → Install from VSIX… → bobgraph-0.0.1.vsix
```

### Prerequisite — language model

BobGraph uses VS Code's Language Model API. Any of these works:

| Provider | How to enable |
|---|---|
| **GitHub Copilot** | Sign in to Copilot in VS Code, then allow BobGraph to use language models when prompted |
| **IBM Bob** | IBM Bob registers itself with VS Code; no extra configuration needed |
| Other compatible provider | Install it; VS Code exposes it automatically |

Run **BobGraph: Check Language Model Connection** from the Command Palette to verify the connection before generating your first graph.

### Generate and open

1. Open your project folder in VS Code (`File → Open Folder`).
2. Run **BobGraph: Generate Workspace Graph** from the Command Palette (`Ctrl+Shift+P`).
3. Run **BobGraph: Open Workspace Visualizer** — or click **Open Workspace Visualizer** in the welcome notification.
4. The graph loads automatically. Click any node to read its details and AI summary.

The generated graph is saved as `.bobgraph/workspace-graph.json` in your project. Re-run **Generate Workspace Graph** at any time to refresh it after code changes.

---

## The interface

### Three-panel layout

```
┌──────────────┬──────────────────────────────┬──────────────────────┐
│  Left panel  │       Graph canvas           │    Right panel       │
│              │                              │                      │
│  Refresh     │   Interactive Cytoscape      │  Node details        │
│  Export      │   graph — pan, zoom,         │  Pseudocode summary  │
│  controls    │   click, double-click        │  AI Assistant        │
└──────────────┴──────────────────────────────┴──────────────────────┘
```

### Node colours

| Colour | Node type | What it represents |
|---|---|---|
| 🔵 Blue rectangle | `file` | One source file in your workspace |
| 🟣 Purple rounded box | `class` | A class or interface |
| 🩵 Sky ellipse | `method` | A method on a class |
| 🟢 Green ellipse | `function` | A standalone function |
| 🔴 Red diamond | `decision` | A branch, condition, or decision point |
| 🩵 Cyan pill | `start_end` | Module entry or exit point |

### Edge types

| Arrow style | Relation | Meaning |
|---|---|---|
| Blue | `imports` | This file imports that file |
| Teal | `calls` | This function/method calls that one |
| Grey | `contains` | This node owns/contains that node |
| Light | `flow` | Execution flows from here to there |

---

## Workspace graph

The workspace view shows your entire project at a glance:

- **One node per file** — every supported file in your workspace becomes a node.
- **Edges show dependencies** — arrows connect files that import each other.
- **Hover** any node to dim everything else and highlight its direct connections.
- **Single-click** a node to load its details and AI pseudocode in the right panel.
- **Double-click** a file node to drill into its internal flowchart.

### How the graph is built

```
Scan workspace files (up to 300)
        ↓
Create one node per file
        ↓
Read short source excerpts
        ↓
Ask the language model to infer import relationships
        ↓
Fall back to deterministic relative-import detection
        ↓
Remove invalid edges (unknown nodes, duplicates)
        ↓
Validate and save .bobgraph/workspace-graph.json
```

The deterministic fallback recognises:

```ts
import Button from "./Button";         // TypeScript / JavaScript
const config = require("./config");    // CommonJS
from .helpers import formatValue       // Python
```

Only relationships between known workspace nodes are kept — an AI hallucination cannot create a phantom file.

---

## File flowchart

Double-clicking any file node replaces the workspace graph with a semantic flowchart of that file:

- **Top-to-bottom dagre layout** — entry → decisions → exit.
- **One node per concept**, not per source line (classes, functions, decisions, external calls).
- **Breadcrumb** above the canvas shows `Workspace › filename.ts`.
- Click **← Back to Workspace** to return to the overview.
- Click **Refresh Graph** to re-run the layout if nodes look cramped.

If the file has no flowchart data available, the panel stays on the workspace view and explains why in the details panel — you are never left on a half-loaded screen.

---

## AI features

### Node explanation (pseudocode)

Click any node to load a plain-language explanation into the right panel. The explanation covers:

- What this code element does.
- Its main responsibilities.
- Important inputs, outputs, and dependencies.

### AI Assistant

Select a node, type a question in the **Ask the AI assistant** input, and press **Send** (or `Enter`). The assistant answers in the context of that node's source file.

Example questions:
- *"What does this function return when the list is empty?"*
- *"Which other files depend on this one?"*
- *"Explain the error handling in this class."*

### Open in IDE

Every node details panel includes an **Open in IDE** button. It opens the source file in your editor with the cursor on the exact line — the fast path from graph to code.

---

## Supported files

The scanner picks up common source, configuration, documentation, and web files:

```
TypeScript · JavaScript · JSX/TSX · Python · Java · C# · C/C++ · Go
Rust · Ruby · PHP · Swift · Kotlin · Scala · HTML · CSS/SCSS/Less
JSON · YAML/TOML/XML · Markdown · Shell scripts · SQL · GraphQL · Proto
```

Ignored automatically: `node_modules`, `.git`, `dist`, `out`, `build`, `.bobgraph`, `.vscode`, `coverage`, `.next`, `.nuxt`, `vendor`, `target`, and any directory starting with `.`.

Current scan limit: **300 files**. Large monorepos may have an incomplete graph.

---

## Commands

Run any command from the Command Palette (`Ctrl+Shift+P`):

| Command | What it does |
|---|---|
| **BobGraph: Open Workspace Visualizer** | Opens the graph panel |
| **BobGraph: Generate Workspace Graph** | Scans the workspace and writes `.bobgraph/workspace-graph.json` |
| **BobGraph: Show Getting Started** | Reopens the 5-step walkthrough |
| **BobGraph: Check Language Model Connection** | Verifies the AI provider is reachable |

---

## Known limitations

| Area | Detail |
|---|---|
| **File-level granularity** | Each workspace node is one file. A large file with many components still shows as a single node until you drill in. |
| **Runtime flow not modelled** | Import graphs do not explain click → API request → database → response chains. BobGraph shows files and dependencies, not request traces. |
| **Framework conventions** | Relationships created by convention (Next.js routing, React component registration, dependency injection, Redux stores) are often missed because they are not direct imports. |
| **Path aliases** | `import Button from "@/components/Button"` may not resolve unless the AI infers it. The deterministic fallback only handles relative paths. |
| **AI estimates** | The model receives short source excerpts. Important imports outside those excerpts may be missed. Treat explanations as onboarding aids, not formal analysis. |
| **Large graphs** | Past 400 nodes the layout switches from physics (`cose`) to `grid` to stay responsive. All nodes still render. |
| **Web assets** | CSS, images, fonts, and HTML asset references are not fully connected. |

---

## Development setup

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host, then:

1. Open any project folder in the new window.
2. Run **BobGraph: Generate Workspace Graph**.
3. Run **BobGraph: Open Workspace Visualizer**.

### Scripts

| Command | Purpose |
|---|---|
| `npm run compile` | Compile TypeScript |
| `npm run watch` | Compile continuously |
| `npm run lint` | Run ESLint |
| `npm test` | Compile and run unit tests |
| `npm run test:integration` | Run VS Code integration tests |

---

## Project structure

```
src/
├── extension.ts              Commands, webview panel, message routing
├── graphProvider.ts          Provider interface, LanguageModelGraphProvider, MockGraphProvider
├── openFile.ts               Webview → IDE file-opening with path validation
└── bob/
    ├── bobAdapter.ts         VS Code Language Model API integration
    ├── graphBuilder.ts       Node construction and deterministic import edges
    ├── graphStore.ts         Schema types, validation, read/write
    ├── workspaceScanner.ts   Workspace file discovery
    └── explainNode.ts        Safe workspace-relative path resolution

media/
├── webview.html              Visualizer markup
├── webview.js                Cytoscape graph UI, drill-down, AI assistant
├── style.css                 VS Code theme-aware styles
├── icon.png                  Extension icon
├── workspace-graph.json      Sample workspace graph (bundled)
├── flowcharts/               Sample per-file flowcharts (bundled)
│   ├── todo-app.json
│   └── storage-util.json
└── walkthrough/              Getting-started step bodies (editable without rebuild)
    ├── 01-welcome.md
    ├── 02-open.md
    ├── 03-workspace.md
    ├── 04-drilldown.md
    └── 05-pseudocode.md
```

For the full implementation notes — webview sandbox, CSP directives, dagre wiring, data contract, message protocol — see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

For the graph JSON schema and the `loadModel` message seam, see [`HANDOFF.md`](./HANDOFF.md).

---

## License

MIT — see [`LICENSE`](./LICENSE).
