![BOB AI Visualizer](../icon.png)

# Read Pseudocode and Jump to Source

Clicking any node fills the right panel with:

1. **Type badge + name** — what kind of node it is, colour-matched to the graph.
2. **File path and line** — exactly where in the codebase it lives.
3. **Pseudocode** — a plain-language summary of what that block does, written by IBM Bob 2.0.

Press **Open in IDE** to jump straight to that file with the cursor on the correct line. That is the fast path this extension is built for: skim the graph → read the summary → land exactly where you need to be.

---

## What's coming next

- **AI Assistant** (right panel, below details) — ask questions about any node using the configured VS Code language model.
- **Export JSON** (left sidebar) — save the full graph model for use elsewhere.

See `ARCHITECTURE.md` in the extension folder for the data contract and how to wire real Bob 2.0 output into the `{type:'loadModel'}` message the frontend already handles.
