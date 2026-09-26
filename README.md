# BOB AI - Workspace Visualizer

A VS Code extension that renders a codebase as an interactive graph, with AI-generated
pseudocode on click for fast onboarding.

Two views:

| View | Shows | Layout |
|---|---|---|
| **Workspace** | One node per file, plus how files import each other | `cose` |
| **File Flowchart** | The logic inside one file (Start / Decision / End) | `dagre` |

IBM Bob 2.0 hackathon project, Onboarding category.

## 🚀 Quick Start (For Team Members)

If you are pulling this branch to test the frontend or start backend integration, follow these steps:

### 1. Environment Setup
```bash
npm install
npm run compile
```

### 2. Launching the Visualizer
1. Press <kbd>F5</kbd> in VS Code to open the **Extension Development Host**.
2. In the new window, press <kbd>Ctrl+Shift+P</kbd> to open the Command Palette.
3. Type and run: **`BOB AI: Open Workspace Visualizer`**.

---

## 🛠️ Development Details

### Core Workflow
- **Dev Loop:** Edit code $\rightarrow$ `npm run compile` (or `npm run watch`) $\rightarrow$ Reload Development Host.
- **Testing:** Run `npm test` for a fast unit suite that verifies the graph logic and data sanitization.
- **Packaging:** Use `npx @vscode/vsce package` to create a `.vsix` installable file.

### Project Layout
```
bobai-visualizer/
├── src/
│   ├── extension.ts              Extension host: creates the panel, injects asset URIs
│   └── test/                    Unit and integration test suites
└── media/                        Everything the webview can load
    ├── webview.html              Panel markup + CSP + CDN script tags
    ├── webview.js                All frontend logic (no framework)
    ├── style.css                 VS Code-themed styling, CSS variables
    ├── workspace-graph.json      Workspace view data (THE CONTRACT)
    ├── walkthrough/              Onboarding steps (markdown)
    └── flowcharts/               Flowchart data (one JSON per file)
```

## 📖 Documentation
If you are integrating the Bob 2.0 backend, read these in order:

1. **`HANDOFF.md`** $\rightarrow$ **Start here.** Contains the exact JSON contract and the three ways to feed real data into the frontend.
2. **`ARCHITECTURE.md`** $\rightarrow$ Explains the webview sandbox, the URI injection scheme, and the message flow.

## 📏 Rules for this Repo
- **Asset Location:** All frontend assets must live in `media/`. Adding files elsewhere requires updating `localResourceRoots` in `src/extension.ts`.
- **Data Contract:** Do not change the field names in `workspace-graph.json` without coordinating with the backend team.
