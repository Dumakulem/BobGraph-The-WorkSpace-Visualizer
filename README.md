# BOB AI - Workspace Visualizer

A VS Code extension that renders a codebase as an interactive graph, with AI-generated
pseudocode on click for fast onboarding.

Two views:

| View | Shows | Layout |
|---|---|---|
| **Workspace** | One node per file, plus how files import each other | `cose` |
| **File Flowchart** | The logic inside one file (Start / Decision / End) | `dagre` |

IBM Bob 2.0 hackathon project, Onboarding category.

## Running it

### For development

```bash
npm install
npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then run
**BOB AI: Open Workspace Visualizer** from the Command Palette (<kbd>Ctrl+Shift+P</kbd>).

F5 is only the dev loop - it is not how end users start the extension.

### For users

After installing the packaged `.vsix`, the extension contributes:

| Entry point | What it does |
|---|---|
| **Welcome page** | Shown on first run (`welcomePage.showOnStartup: "Walkthrough"`) |
| **Walkthrough** | 5-step "Get Started" guide in Help > Welcome, under Getting Started |
| **Command** | `BOB AI: Open Workspace Visualizer` (<kbd>Ctrl+Shift+P</kbd>) |

There is no activation event to worry about - VS Code activates the extension the first time
its command is run. The walkthrough's second step links straight to that command, and marks
itself complete once you run it.

To try the packaging path:

```bash
npx @vscode/vsce package     # -> bobai-visualizer-0.0.1.vsix
```

`publisher` in `package.json` is set to `bob-ai-team` as a placeholder - change it to a name
your team owns before publishing, since it becomes part of the public extension ID
(`<publisher>.bobai-visualizer`). `vsce` also warns about a missing `license`, `icon`, and
`repository`; those are cosmetic and will not block packaging.

Other scripts:

```bash
npm run watch    # recompile on change
npm run lint     # eslint
npm run pretest  # compile + lint
npm test         # fast unit suite (Node's built-in runner, no VS Code needed)
```

`npm test` covers the manifest wiring, the shipped JSON and CSP, and the real behaviour of
`media/webview.js` driven through a stubbed DOM - including the drill-down state machine and
the dagre wiring. It finishes in well under a second and needs no downloads.

Activation and command registration need a real VS Code instance, so they live in a separate
host suite:

```bash
npm run test:integration   # downloads VS Code on first run
```

See `ARCHITECTURE.md` section 13 for what each file covers.

Walkthrough copy lives in `media/walkthrough/*.md` and is referenced from `package.json`.
Editing a step means editing the matching markdown file - no rebuild needed.

## Project layout

```
bobai-visualizer/
├── src/
│   ├── extension.ts              Extension host: creates the panel, injects asset URIs
│   └── test/
│       ├── helpers.ts            Shared paths and file readers
│       ├── manifest.unit.test.ts Command + walkthrough + theming + packaging rules
│       ├── data.unit.test.ts     JSON, slug resolution, CSP, script order, dead controls
│       ├── webview.unit.test.ts  Runs the real webview.js in a stubbed DOM
│       └── extension.host.test.ts  Activation, needs a real VS Code instance
└── media/                        Everything the webview can load
    ├── webview.html              Panel markup + CSP + CDN script tags
    ├── webview.js                All frontend logic (no framework)
    ├── style.css                 VS Code-themed styling, CSS variables
    ├── workspace-graph.json      Workspace view data
    ├── walkthrough/              Onboarding steps, one markdown file per step
    └── flowcharts/
        ├── todo-app.json         Flowchart data, one file per JSON
        └── storage-util.json
```

`../BobGraph-The-WorkSpace-Visualizer/` is an older standalone copy of the same UI for
opening `webview.html` directly in a browser. It is **not** shipped in the extension and has
drifted behind `media/` — treat `media/` as the source of truth.

## Documentation

Documentation:

**`HANDOFF.md`** - what the backend team needs: the exact JSON contract, the three ways to
feed real Bob 2.0 data in, error behaviour you can rely on, and prioritised open work.
Start there if you are taking over the integration.

**`ARCHITECTURE.md`** (in this folder) explains how the extension actually works: the webview
sandbox, the URI injection scheme, the JSON data contract, and the message flow. Start there
if you are new to the codebase or integrating the Bob 2.0 backend.

> The reference to it is plain text rather than a relative link on purpose: `vsce package`
> refuses to build while a README contains relative links and no `repository` is set. Once you
> add a `repository` to `package.json`, turn the line above into a normal relative markdown
> link so it becomes clickable.

## Rules for this repo

- Do not run `git commit` or `git push`. Commits are the team lead's job.
- `media/` is the only directory the webview may read from. Adding an asset elsewhere
  requires updating `localResourceRoots` in `src/extension.ts`.
