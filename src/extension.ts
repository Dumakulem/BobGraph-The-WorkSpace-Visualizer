import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GraphPanel } from './panel/graphPanel';
import { runBobGraphGeneration } from './bob/bobAdapter';
import { ensureGraphDir, graphFilePath } from './bob/graphStore';

/**
 * Extension host. Owns the webview panel, asset URI injection, and file-opening requests.
 * See ARCHITECTURE.md for the full picture.
 *
 * Security notes (from fix/scaffold-hardening):
 * - Asset URIs are injected via asWebviewUri — no file:// or relative paths.
 * - The CSP in webview.html allows only the CDNs actually used and the webview origin.
 * - acquireVsCodeApi() is called once and parked on window.vscode.
 * - MOCK_DATA_URI is injected as a JSON-encoded string so the webview can fetch sample data.
 */
export function activate(context: vscode.ExtensionContext) {
 // ── BobGraph: LM-powered graph panel ────────────────────────────────────────
 // Register the bobgraph.* commands consumed by GraphPanel and the test suite.
 // These live alongside the existing bobai-visualizer.* commands and share the
 // same extension context.
 GraphPanel.setExtensionUri(context.extensionUri);

 context.subscriptions.push(
  vscode.commands.registerCommand('bobgraph.openVisualizer', () => {
   GraphPanel.createOrShow(context.extensionUri);
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

 // ── BOB AI Visualizer (existing feature set) ─────────────────────────────
    const WALKTHROUGH_ID = 'bobaiVisualizer.gettingStarted';

    const showGettingStarted = () =>
        vscode.commands.executeCommand('workbench.action.openWalkthrough', [
            context.extension.id,
            WALKTHROUGH_ID
        ]);

    // This palette entry is the only guaranteed way to reopen the walkthrough. VS Code's own
    // auto-open is not usable here: `showOnStartup` is not a walkthrough property at all
    // (verified against the 1.139 manifest schema), and the native auto-open slot is shared
    // with every other extension, so IBM Bob can and does claim it first.
    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.showGettingStarted', showGettingStarted)
    );

    // One-time intro, owned by us rather than by the Welcome page. Fires on the first
    // activation after install and then never again - a Welcome-page popup competes with
    // every other extension and is not dismissable-per-extension.
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

    const disposable = vscode.commands.registerCommand('bobai-visualizer.openVisualizer', () => {
        // Sandbox: the webview may only read files under media/, and never via file:// or
        // relative paths. asWebviewUri is the only way to reference a local asset.
        const panel = vscode.window.createWebviewPanel(
            'bobVisualizer',
            'BOB AI - Workspace Visualizer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
            }
        );

        panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png'));

        const mediaPath = path.join(context.extensionPath, 'media');

        const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'style.css')));
        const jsUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'webview.js')));
        const dataUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'workspace-graph.json')));
        const iconUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'icon.png')));

        let htmlContent = fs.readFileSync(path.join(mediaPath, 'webview.html'), 'utf8');

        // Every {{placeholder}} and ${webview.cspSource} in webview.html must be replaced,
        // or the CSP silently drops those sources and blocks the assets.
        htmlContent = htmlContent
            .replace(/{{styleUri}}/g, styleUri.toString())
            .replace(/{{jsUri}}/g, jsUri.toString())
            .replace(/{{iconUri}}/g, iconUri.toString())
            .replace(/\$\{webview\.cspSource\}/g, panel.webview.cspSource);

        // acquireVsCodeApi() may only be called once per webview, so the handle is parked
        // on window for webview.js to use for postMessage.
        // MOCK_DATA_URI provides the sample graph data URI so the webview can fetch it
        // without hardcoding a file:// path.
        const bootstrapScript = [
            `<script>window.MOCK_DATA_URI = ${JSON.stringify(dataUri.toString())};</script>`,
            '<script>window.vscode = acquireVsCodeApi();</script>'
        ].join('');
        htmlContent = htmlContent.replace('</head>', `${bootstrapScript}</head>`);

        panel.webview.html = htmlContent;

        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.type) {
                    case 'openFile':
                        if (typeof message.filePath === 'string' && typeof message.line === 'number') {
                            const targetLine = Math.max(0, message.line - 1);
                            vscode.workspace.openTextDocument(vscode.Uri.file(message.filePath)).then(
                                doc => vscode.window.showTextDocument(doc, {
                                    selection: new vscode.Range(targetLine, 0, targetLine, 0)
                                }),
                                err => vscode.window.showErrorMessage(`Could not open ${message.filePath}: ${err.message}`)
                            );
                        }
                        break;
                }
            },
            undefined,
            context.subscriptions
        );
    });

    context.subscriptions.push(disposable);
}

// ─── BobGraph: graph generation helper ───────────────────────────────────────

async function runGenerateGraph(): Promise<void> {
 const folders = vscode.workspace.workspaceFolders;
 if (!folders || folders.length === 0) {
  void vscode.window.showErrorMessage(
   'BobGraph: No workspace folder is open. Open a folder first.',
  );
  return;
 }
 const workspaceRoot = folders[0].uri.fsPath;

 await vscode.window.withProgress(
  {
   location: vscode.ProgressLocation.Notification,
   title: 'BobGraph: Generating workspace graph with Bob…',
   cancellable: false,
  },
  async () => {
   try {
    await ensureGraphDir(workspaceRoot);
    const outFile = graphFilePath(workspaceRoot);
    await runBobGraphGeneration(workspaceRoot);
    const action = await vscode.window.showInformationMessage(
    	`Workspace graph written to ${outFile}`,
    	'Open Visualizer',
    );
    if (action === 'Open Visualizer') {
    	GraphPanel.createOrShow();
    }
   } catch (error) {
    void vscode.window.showErrorMessage(`BobGraph: ${String(error)}`);
   }
  },
 );
}

export function deactivate() {}
