# BobGraph - Workspace Visualizer

BobGraph is a VS Code extension that turns a codebase into an interactive graph. It
helps developers understand an unfamiliar project by showing file dependencies and
AI-generated explanations of the code.

BobGraph is primarily a **file dependency visualizer**. It is not a complete runtime
or web-application architecture analyzer.

## What it can do

### Workspace graph

The workspace view:

- Scans the open workspace for supported files.
- Creates one graph node for each discovered file.
- Uses the file's relative path as its node ID.
- Shows relationships between files, mainly imports and dependencies.
- Opens the source file in VS Code when a node is selected.
- Uses an interactive Cytoscape graph layout.

For example:

```text
src/App.tsx ── imports ──> src/components/Header.tsx
```

The generated workspace graph is saved as:

```text
.bobgraph/workspace-graph.json
```

### File flowchart

Selecting a file can generate a more detailed semantic flowchart. Instead of creating
one node per line, BobGraph asks the language model to identify meaningful concepts
such as:

- Functions and methods
- Classes and interfaces
- Important properties or state
- Decisions and branches
- Transformations
- External services
- Module entry and exit points

The flowchart edges can describe relationships such as `calls`, `contains`, `reads`,
`writes`, `transforms`, `returns`, and `branches to`.

### AI explanations

BobGraph can use a VS Code language model to:

- Infer dependencies from source excerpts.
- Generate file flowcharts.
- Explain the purpose and responsibilities of a selected node or file.
- Answer questions about the selected file.

The language model must be available through the VS Code Language Model API, for
example through GitHub Copilot or another compatible provider.

If AI dependency inference fails, BobGraph falls back to deterministic detection of
relative imports in TypeScript, JavaScript, and Python files.

## How graph generation works

```text
Scan workspace files
        ↓
Create one node per file
        ↓
Read short source excerpts
        ↓
Ask the language model to infer relationships
        ↓
Fall back to relative-import detection if needed
        ↓
Remove invalid and duplicate edges
        ↓
Validate and save the graph
```

The deterministic fallback recognizes patterns such as:

```ts
import Button from "./Button";
const config = require("./config");
from .helpers import formatValue;
```

Only relationships whose source and target files are known workspace nodes are kept.
This prevents an invalid AI response from creating references to files that do not
exist in the graph.

## Supported files and scan limits

The scanner recognizes common source, configuration, documentation, and web files,
including:

```text
TypeScript, JavaScript, JSX, TSX, Python, Java, C#, C/C++, Go, Rust,
Ruby, PHP, Swift, Kotlin, Scala, HTML, CSS, SCSS, Less, JSON, YAML,
TOML, XML, Markdown, text, shell scripts, SQL, GraphQL, and Protocol Buffers
```

The scanner ignores common generated, dependency, and tooling directories such as
`node_modules`, `.git`, `dist`, `build`, `out`, `.bobgraph`, `.vscode`, and
`coverage`.

The current scan limit is **300 files**. Large projects may therefore have an
incomplete workspace graph.

## Limitations

### It models files more reliably than runtime behavior

At the workspace level, a node normally represents an entire file. A large
`Dashboard.tsx` file containing components, hooks, event handlers, API calls, and
state updates is still represented as one workspace node.

The file flowchart provides more detail, but it is generated from a limited source
excerpt and should be treated as an explanation rather than a formal program analysis.

### Imports are not the same as application flow

An import graph does not fully explain a web application's runtime path:

```text
button click
  → event handler
  → API request
  → server route
  → database query
  → response
  → UI update
```

BobGraph may show the files involved, but it does not reliably construct this complete
browser-to-server-to-database flow.

### Framework conventions are only partially understood

Relationships created implicitly by frameworks may be missed, including:

- React, Vue, Angular, or framework component registration
- Next.js or other file-based routing
- Express or server route registration
- Middleware
- Dependency injection
- Redux, Zustand, or other state-management relationships
- Server actions and framework-specific loaders
- WebSocket handlers

These relationships are often created by configuration, naming conventions, decorators,
or runtime registration rather than direct imports.

### Path aliases and dynamic imports may be missed

The deterministic fallback focuses on relative paths such as `./Button`. It may not
resolve aliases such as:

```ts
import Button from "@/components/Button";
```

unless the AI correctly infers the relationship. Dynamic imports whose target is
calculated at runtime are also difficult to resolve statically.

### Web assets are not fully connected

The scanner can create nodes for HTML, CSS, JSON, and other assets, but the current
relationship logic is focused mainly on TypeScript, JavaScript, and Python imports.
It does not consistently model all relationships involving:

- CSS and stylesheets
- Images, fonts, and SVG files
- HTML script and stylesheet references
- Bundler entry points
- Build-time asset transformations

### AI results are estimates

The language model only receives short source excerpts for workspace dependency
inference. Important imports or relationships outside those excerpts may be missed.
AI-generated flowcharts and explanations can also be incomplete or incorrect.

Use the graph as an onboarding aid and navigation tool, not as a security report,
compiler result, or source-of-truth architecture specification.

### Large graphs become harder to read

Graphs with many nodes can become visually dense. BobGraph changes its layout strategy
for large graphs to avoid expensive physics calculations, but this improves
responsiveness rather than readability.

## Why it is not yet optimal for web applications

Modern web applications are not only collections of imported files. They combine:

- Client components and server components
- Routes and page conventions
- Browser events
- API and RPC calls
- Server middleware
- Databases and external services
- State stores
- Build tools and aliases
- Dynamic loading
- Static assets

BobGraph currently captures the most reliable common denominator: **files and their
known dependencies**. It is useful for learning a codebase and finding related files,
but it does not yet provide a complete component graph, request trace, data-flow graph,
or deployment architecture diagram.

## Getting started

### For development

```bash
npm install
npm run compile
```

Then:

1. Open this project in VS Code.
2. Press `F5` to start an Extension Development Host.
3. Open a project in the new VS Code window.
4. Run **BobGraph: Generate Workspace Graph**.
5. Run **BobGraph: Open Workspace Visualizer**.
6. Select a file node to inspect it and open its flowchart.

### Useful commands

```bash
npm run compile  # Compile TypeScript
npm run lint     # Run ESLint
npm test         # Compile and run unit tests
npm run watch    # Compile continuously during development
```

## Project structure

```text
src/
├── extension.ts              VS Code commands, webview, and messages
├── graphProvider.ts           Graph-generation provider interface
└── bob/
    ├── workspaceScanner.ts    Workspace file discovery
    ├── graphBuilder.ts        File nodes and deterministic import edges
    ├── bobAdapter.ts          AI integration and graph generation
    ├── graphStore.ts          Graph schema, validation, and persistence
    └── explainNode.ts          Safe source-file path resolution

media/
├── webview.html               Visualizer markup
├── webview.js                 Cytoscape graph UI
└── style.css                  Visualizer styling
```

For implementation details about the VS Code webview boundary and message flow, see
[`ARCHITECTURE.md`](./ARCHITECTURE.md). For the graph data contract, see
[`HANDOFF.md`](./HANDOFF.md).

## License

This project is licensed under the MIT License.
