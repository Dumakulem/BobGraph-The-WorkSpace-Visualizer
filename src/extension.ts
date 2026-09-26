import * as vscode from 'vscode';
import { GraphPanel } from './panel/graphPanel';
import { runBobGraphGeneration } from './bob/bobAdapter';
import { ensureGraphDir, graphFilePath } from './bob/graphStore';

/**
 * Extension host. Owns the webview panel, asset URI injection, and file-opening requests.
 * See ARCHITECTURE.md for the full picture.
 */
export function activate(context: vscode.ExtensionContext) {
 // ── BobGraph: LM-powered graph panel ────────────────────────────────────────
 // Register the bobgraph.* commands consumed by GraphPanel and the test suite.
 // These live alongside the existing bobai-visualizer.* commands and share the
 // same extension context.
 GraphPanel.setExtensionUri(context.extensionUri);

 // bobgraph.openVisualizer — opens the generated graph in the GraphPanel.
 context.subscriptions.push(
  vscode.commands.registerCommand('bobgraph.openVisualizer', () => {
   openVisualizerOrPromptGenerate(context);
  }),
 );

 context.subscriptions.push(
  vscode.commands.registerCommand('bobgraph.refresh', () => {
   void GraphPanel.refresh();
  }),
 );

 context.subscriptions.push(
  vscode.commands.registerCommand('bobgraph.generateGraph', () => {
   void runGenerateGraph();
  }),
 );

 // ── BOB AI Visualizer commands ───────────────────────────────────────────────
 // bobai-visualizer.openVisualizer now routes through GraphPanel (generated graph)
 // instead of the old bundled-sample webview, so both command IDs show the same view.
    const WALKTHROUGH_ID = 'bobaiVisualizer.gettingStarted';

    const showGettingStarted = () =>
        vscode.commands.executeCommand('workbench.action.openWalkthrough', [
            context.extension.id,
            WALKTHROUGH_ID
        ]);

    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.showGettingStarted', showGettingStarted)
    );

    // bobai-visualizer.openVisualizer is the command referenced by walkthrough links and
    // welcome page. Route it to the same GraphPanel path so users always see the
    // generated graph, never the stale bundled sample.
    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.openVisualizer', () => {
            openVisualizerOrPromptGenerate(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.generateGraph', () => {
            void runGenerateGraph();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.refreshGraph', () => {
            void GraphPanel.refresh();
        })
    );

    // One-time intro, owned by us rather than by the Welcome page.
    const INTRO_SEEN = 'bobaiVisualizer.introSeen';
    if (!context.globalState.get(INTRO_SEEN)) {
        void context.globalState.update(INTRO_SEEN, true);
        void vscode.window
            .showInformationMessage(
                'Welcome to BOB AI - Workspace Visualizer. Take the 2-minute tour?',
                'Start Tour',
                'Not Now'
            )
            .then(choice => {
                if (choice === 'Start Tour') {
                    void showGettingStarted();
                }
            });
    }
}

// ─── Open-visualizer helper ───────────────────────────────────────────────────
//
// Opens the GraphPanel. If the generated graph file does not yet exist, offers
// to generate it first rather than silently showing an error state.

function openVisualizerOrPromptGenerate(context: vscode.ExtensionContext): void {
 const folders = vscode.workspace.workspaceFolders;
 if (!folders || folders.length === 0) {
  void vscode.window.showErrorMessage(
   'BOB AI: No workspace folder is open. Open a folder first.',
  );
  return;
 }

 const workspaceRoot = folders[0].uri.fsPath;
 const generatedFile = graphFilePath(workspaceRoot);

 // Check whether the generated file exists. If it does, open the panel directly.
 // If it does not, prompt the user to generate it first.
 import('node:fs').then(({ existsSync }) => {
  if (existsSync(generatedFile)) {
   GraphPanel.createOrShow(context.extensionUri);
  } else {
   void vscode.window
    .showInformationMessage(
     'BOB AI: No workspace graph found. Generate one first?',
     'Generate Graph',
     'Cancel',
    )
    .then(choice => {
     if (choice === 'Generate Graph') {
      void runGenerateGraph().then(() => {
       GraphPanel.createOrShow(context.extensionUri);
      });
     }
    });
  }
 });
}

// ─── BobGraph: graph generation helper ───────────────────────────────────────

async function runGenerateGraph(): Promise<void> {
 const folders = vscode.workspace.workspaceFolders;
 if (!folders || folders.length === 0) {
  void vscode.window.showErrorMessage(
   'BOB AI: No workspace folder is open. Open a folder first.',
  );
  return;
 }
 const workspaceRoot = folders[0].uri.fsPath;

 await vscode.window.withProgress(
  {
   location: vscode.ProgressLocation.Notification,
   title: 'BOB AI: Generating workspace graph…',
   cancellable: false,
  },
  async () => {
   try {
    await ensureGraphDir(workspaceRoot);
    const outFile = graphFilePath(workspaceRoot);
    await runBobGraphGeneration(workspaceRoot);
    const action = await vscode.window.showInformationMessage(
    	`BOB AI: Workspace graph written to ${outFile}`,
    	'Open Visualizer',
    );
    if (action === 'Open Visualizer') {
    	GraphPanel.createOrShow();
    }
   } catch (error) {
    void vscode.window.showErrorMessage(`BOB AI: ${String(error)}`);
   }
  },
 );
}

export function deactivate() {}
