import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { explainNode } from '../bob/explainNode';
import { generateGraph } from '../bob/generateGraph';
import type { GraphData } from '../bob/generateGraph';

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'nodeClicked'; nodeId: string };

export class GraphPanel {
	private static currentPanel: GraphPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.panel.webview.html = this.getHtmlForWebview();

		this.panel.webview.onDidReceiveMessage(
			(message: WebviewMessage) => {
				void this.handleWebviewMessage(message);
			},
			null,
			this.disposables,
		);

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	public static createOrShow(extensionUri: vscode.Uri): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (GraphPanel.currentPanel) {
			GraphPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'bobgraph',
			'BobGraph',
			column,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview')],
			},
		);

		GraphPanel.currentPanel = new GraphPanel(panel, extensionUri);
	}

	private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.sendGraph();
				break;
			case 'nodeClicked':
				await this.sendExplanation(message.nodeId);
				break;
			default:
				break;
		}
	}

	private async sendGraph(): Promise<void> {
		try {
			await this.panel.webview.postMessage({ type: 'graphLoading' });
			const graph: GraphData = await generateGraph();
			await this.panel.webview.postMessage({ type: 'graphData', graph });
		} catch (error) {
			await this.sendError(`Unable to generate the workspace graph: ${String(error)}`);
		}
	}

	private async sendExplanation(nodeId: string): Promise<void> {
		try {
			await this.panel.webview.postMessage({ type: 'explanationLoading', nodeId });
			const summary = await explainNode(nodeId);
			await this.panel.webview.postMessage({ type: 'nodeExplanation', nodeId, summary });
		} catch (error) {
			await this.sendError(`Unable to explain node "${nodeId}": ${String(error)}`);
		}
	}

	private async sendError(message: string): Promise<void> {
		console.error(message);
		await this.panel.webview.postMessage({ type: 'error', message });
	}

	private getHtmlForWebview(): string {
		const webview = this.panel.webview;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'main.js'));
		const visNetworkUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'vendor', 'vis-network.min.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'style.css'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
	<title>BobGraph</title>
</head>
<body>
	<header>
		<h1>BobGraph</h1>
		<p id="status">Loading workspace graph...</p>
	</header>
	<main id="graph" aria-label="Workspace graph"></main>
	<aside id="details" hidden>
		<h2>Node summary</h2>
		<p id="summary"></p>
	</aside>
	<script nonce="${nonce}" src="${visNetworkUri}"></script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private dispose(): void {
		GraphPanel.currentPanel = undefined;
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		this.panel.dispose();
	}
}

function getNonce(): string {
	return randomBytes(16).toString('hex');
}
