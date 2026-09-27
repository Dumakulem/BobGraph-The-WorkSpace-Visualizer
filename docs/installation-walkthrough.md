# BobGraph — Installation Walkthrough

> **Template** — add your screenshots above each step heading where indicated, then remove this notice.

---

## Step 1 — Install the extension

<!-- 📸 SCREENSHOT: VS Code Extensions panel with "Install from VSIX…" menu open -->
![Install from VSIX](./images/01-install-vsix.png)

Open VS Code and go to the **Extensions** panel (`Ctrl+Shift+X`).

Click the **⋯** (More Actions) button at the top right of the Extensions panel, then choose **Install from VSIX…**

Navigate to `bobgraph-0.0.1.vsix` and confirm the install.

> **Marketplace install:** If BobGraph is published to the marketplace, search **BobGraph** in the Extensions panel and click **Install** — no VSIX needed.

---

## Step 2 — Verify the language model connection

<!-- 📸 SCREENSHOT: Command Palette open with "BobGraph: Check Language Model Connection" typed -->
![Check language model](./images/02-check-model.png)

BobGraph needs a VS Code language model to generate graphs and AI summaries. Any of these works:

- **GitHub Copilot** — sign in to Copilot in VS Code; allow BobGraph to use language models when prompted.
- **IBM Bob** — registers itself automatically; no extra steps needed.
- Any other provider that exposes the VS Code Language Model API.

Open the Command Palette (`Ctrl+Shift+P`), type **BobGraph: Check Language Model Connection**, and press `Enter`. A notification will confirm the model name and vendor, or tell you what is missing.

---

## Step 3 — Open your project

<!-- 📸 SCREENSHOT: VS Code with a project folder open in the Explorer panel -->
![Open folder](./images/03-open-folder.png)

Use **File → Open Folder** to open the project you want to visualize. BobGraph works on any folder — it does not need to be a Git repository or a specific language.

---

## Step 4 — Generate the workspace graph

<!-- 📸 SCREENSHOT: Command Palette with "BobGraph: Generate Workspace Graph" and the success notification toast -->
![Generate graph](./images/04-generate-graph.png)

Open the Command Palette (`Ctrl+Shift+P`) and run **BobGraph: Generate Workspace Graph**.

BobGraph will:
1. Scan your workspace for supported files (up to 300).
2. Ask the language model to infer import relationships.
3. Fall back to deterministic relative-import detection if needed.
4. Save the result to `.bobgraph/workspace-graph.json`.

A success notification appears when the graph is ready. If it fails, check the error message — the most common cause is no language model being available (see Step 2).

---

## Step 5 — Open the visualizer

<!-- 📸 SCREENSHOT: The BobGraph panel open beside the editor, showing the workspace graph -->
![Open visualizer](./images/05-open-visualizer.png)

Run **BobGraph: Open Workspace Visualizer** from the Command Palette, or click **Open Workspace Visualizer** in the welcome notification.

The panel opens alongside your editor and loads the workspace graph automatically. You should see one node per file with arrows connecting files that import each other.

**Controls:**
- **Pan** — click and drag the canvas background.
- **Zoom** — scroll wheel or pinch.
- **Hover** a node — dims everything except its direct connections.
- **Single-click** a node — loads its details and AI pseudocode in the right panel.
- **Double-click** a file node — drills into that file's internal flowchart.

---

## Step 6 — Read node details and AI pseudocode

<!-- 📸 SCREENSHOT: Right panel showing node details with type badge, file path, pseudocode text, and the "Open in IDE" button -->
![Node details panel](./images/06-node-details.png)

Click any node to fill the right panel with:

1. **Type badge** — colour-matched to the node type (file, class, function, etc.).
2. **File path and line** — exactly where in the codebase this element lives.
3. **Pseudocode** — a plain-language summary written by the AI.
4. **Open in IDE** — jumps straight to the source file at the correct line.

---

## Step 7 — Drill into a file flowchart

<!-- 📸 SCREENSHOT: A file flowchart open in the canvas with the breadcrumb "Workspace › App.tsx" and the Back button visible -->
![File flowchart](./images/07-file-flowchart.png)

**Double-click** any file node (blue rectangle) to replace the workspace graph with that file's internal flowchart. The flowchart shows meaningful concepts — classes, functions, decisions, and external calls — laid out top-to-bottom.

The breadcrumb above the canvas shows:

```
Workspace › App.tsx
```

Click **← Back to Workspace** to return to the overview, or **Refresh Graph** to re-run the layout.

---

## Step 8 — Ask the AI assistant a question

<!-- 📸 SCREENSHOT: Right panel with the "Ask the AI assistant" input filled in and a response shown below -->
![AI assistant](./images/08-ai-assistant.png)

With a node selected, scroll to the **Ask the AI assistant** section in the right panel. Type a question about the selected node's source file and press **Send** (or `Enter`).

Example questions:
- *"What does this function return when the list is empty?"*
- *"Which other files depend on this one?"*
- *"Explain the error handling in this class."*

The assistant answers using the source context of the selected file.

---

## Tips

| Situation | What to do |
|---|---|
| Graph looks empty or wrong | Re-run **Generate Workspace Graph** after code changes |
| Panel opens blank | Use **Developer: Open Webview Developer Tools** and check the console |
| Language model unavailable | Run **Check Language Model Connection** and follow the prompt |
| Nodes are hard to read | Use **Refresh Graph** to re-run the layout |
| Want to reopen the walkthrough | Run **BobGraph: Show Getting Started** from the Command Palette |
| More than 300 files | The graph is partial — focus on a sub-folder or increase the limit in a future release |

---

*For the full feature reference see [README.md](../README.md). For implementation details see [ARCHITECTURE.md](../ARCHITECTURE.md).*
