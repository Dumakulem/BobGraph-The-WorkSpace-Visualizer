import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Extension host. Owns the webview panel, asset URI injection, and file-opening requests.
 * See ARCHITECTURE.md for the full picture.
 */
export function activate(context: vscode.ExtensionContext) {
    // showOnStartup only fires on a real first install, which never happens for an
    // extension loaded via F5. This gives the walkthrough a permanent palette entry.
    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.showGettingStarted', () =>
            vscode.commands.executeCommand('workbench.action.openWalkthrough', [
                context.extension.id,
                'bobaiVisualizer.gettingStarted'
            ])
        )
    );

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

        const mediaPath = path.join(context.extensionPath, 'media');

        const styleUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'style.css')));
        const jsUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'webview.js')));
        const dataUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'workspace-graph.json')));

        let htmlContent = fs.readFileSync(path.join(mediaPath, 'webview.html'), 'utf8');

        // Every {{placeholder}} and ${webview.cspSource} in webview.html must be replaced,
        // or the CSP silently drops those sources and blocks the assets.
        htmlContent = htmlContent
            .replace(/{{styleUri}}/g, styleUri.toString())
            .replace(/{{jsUri}}/g, jsUri.toString())
            .replace(/\$\{webview\.cspSource\}/g, panel.webview.cspSource);

        // acquireVsCodeApi() may only be called once per webview, so the handle is parked
        // on window for webview.js to use for postMessage.
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

export function deactivate() {}
