# BobGraph

BobGraph is a VS Code extension for onboarding through an interactive
workspace graph. A graph JSON file describes code elements and their
relationships; the extension validates it and renders it in a webview.

## Current capabilities

- Open **BobGraph: Open Workspace Visualizer** from the Command Palette.
- Load `.bobgraph/workspace-graph.json` from the current workspace.
- Validate node, edge, duplicate-ID, and path-safety constraints.
- Render the graph locally with `vis-network`.
- Refresh the graph from the panel or with **BobGraph: Refresh Graph**.
- Request a placeholder explanation when a node is selected.

The Bob generation and explanation adapter remains an explicit stub until the
IBM Bob integration contract is verified. Use **BobGraph: Generate Workspace
Graph** to exercise that integration boundary.

## Graph format

```json
{
  "nodes": [
    {
      "id": "extension",
      "label": "extension.ts",
      "type": "file",
      "filePath": "src/extension.ts"
    }
  ],
  "edges": [
    {
      "from": "extension",
      "to": "panel",
      "relation": "imports"
    }
  ]
}
```

Store the file at `.bobgraph/workspace-graph.json`. Node paths must be
relative to the workspace and edges must reference existing node IDs.

## Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Compile the extension and webview assets:

   ```bash
   npm run compile
   ```

3. Press `F5` in VS Code to launch an Extension Development Host.

4. Run **BobGraph: Open Workspace Visualizer**.

## Validation

```bash
npm run compile
npm run lint
npm run compile-tests
```

## Requirements

- Visual Studio Code `^1.138.0`
- Node.js and npm

See [`SECURITY.MD`](./SECURITY.MD) for repository security guidance.
