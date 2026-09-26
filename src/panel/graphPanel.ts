import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { explainNode, resolveNodeFilePath } from '../bob/explainNode';
import { readGraph, GraphFileNotFoundError, GraphValidationError } from '../bob/graphStore';
import type { GraphData, GraphNode } from '../bob/graphStore';

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'nodeClicked'; nodeId: string }
	| { type: 'requestRefresh' };

export class GraphPanel {
	private static currentPanel: GraphPanel | undefined;
	// Stored at activation time by extension.ts — valid for the full extension
	// lifetime and never changes, unlike the workspace root.
	private static storedExtensionUri: vscode.Uri | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	// The workspace root captured when this panel was created. Made mutable so
	// createOrShow can update it when the workspace changes and trigger a reload.
	private workspaceRoot: string;
	private readonly disposables: vscode.Disposable[] = [];
	private webviewReady = false;
	private refreshInFlight: Promise<void> | undefined;
	private refreshPending = false;

	// Keeps a copy of the last successfully loaded graph for nodeId → filePath
	// resolution without re-reading the file on every click.
	private graphNodes: Map<string, GraphNode> = new Map();

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		workspaceRoot: string,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.workspaceRoot = workspaceRoot;
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

	/** Called once by extension.ts at activation time. */
	public static setExtensionUri(uri: vscode.Uri): void {
		GraphPanel.storedExtensionUri = uri;
	}

	public static createOrShow(extensionUri?: vscode.Uri): void {
		const uri = extensionUri ?? GraphPanel.storedExtensionUri;
		if (!uri) {
			// Should never happen if setExtensionUri was called at activation.
			void vscode.window.showErrorMessage(
				'BobGraph: Extension URI is not available. Try reloading the window.',
			);
			return;
		}

		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			void vscode.window.showErrorMessage(
				'BobGraph: No workspace folder is open. Open a folder to use BobGraph.',
			);
			return;
		}

		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (GraphPanel.currentPanel) {
			// If the workspace root has changed since the panel was created (e.g.
			// the user switched to a different folder), update the stored root and
			// reload so the panel does not serve stale data from the old workspace.
			if (GraphPanel.currentPanel.workspaceRoot !== workspaceRoot) {
				GraphPanel.currentPanel.workspaceRoot = workspaceRoot;
				GraphPanel.currentPanel.graphNodes.clear();
				if (GraphPanel.currentPanel.webviewReady) {
					void GraphPanel.currentPanel.sendGraph();
				}
			}
			GraphPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'bobgraph',
			'BobGraph',
			column,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(uri, 'dist', 'webview')],
			},
		);

		GraphPanel.currentPanel = new GraphPanel(panel, uri, workspaceRoot);
	}

	/**
	 * Reloads the graph file and pushes updated data to the webview.
	 * Called by the "BobGraph: Refresh" command and by the webview's refresh button.
	 */
	public static async refresh(): Promise<void> {
		if (GraphPanel.currentPanel) {
			await GraphPanel.currentPanel.sendGraph();
		}
	}

	private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.webviewReady = true;
				await this.sendGraph();
				break;
			case 'nodeClicked':
				await this.sendExplanation(message.nodeId);
				break;
			case 'requestRefresh':
				await this.sendGraph();
				break;
			default:
				break;
		}
	}

	private async sendGraph(): Promise<void> {
		if (!this.webviewReady) {
			return;
		}
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return this.refreshInFlight;
		}
		this.refreshInFlight = this.loadGraph();
		try {
			await this.refreshInFlight;
		} finally {
			this.refreshInFlight = undefined;
			if (this.refreshPending) {
				this.refreshPending = false;
				void this.sendGraph();
			}
		}
	}

	private async loadGraph(): Promise<void> {
		await this.panel.webview.postMessage({ type: 'graphLoading' });
		try {
			const graph: GraphData = await readGraph(this.workspaceRoot);
			this.graphNodes = new Map(graph.nodes.map((n) => [n.id, n]));
			await this.panel.webview.postMessage({ type: 'graphData', graph });
		} catch (error) {
			this.graphNodes.clear();
			if (error instanceof GraphFileNotFoundError) {
				await this.sendError(error.message);
			} else if (error instanceof GraphValidationError) {
				await this.sendError(`Graph validation failed: ${error.message}`);
			} else {
				await this.sendError(`Unable to load the workspace graph: ${String(error)}`);
			}
		}
	}

	private async sendExplanation(nodeId: string): Promise<void> {
		try {
			const node = this.graphNodes.get(nodeId);
			if (!node) {
				await this.sendError(`Unknown node id "${nodeId}". Try refreshing the graph.`);
				return;
			}
			const absoluteFilePath = resolveNodeFilePath(this.workspaceRoot, node.filePath);
			await this.panel.webview.postMessage({ type: 'explanationLoading', nodeId });
			const summary = await explainNode(nodeId, absoluteFilePath);
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
		const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'main.js'));
		const visNetworkUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'vendor', 'vis-network.min.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'style.css'));
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
		<button id="refresh" title="Reload .bobgraph/workspace-graph.json">Refresh</button>
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
	}
}

function getNonce(): string {
	return randomBytes(16).toString('hex');
}

function getWorkspaceRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return undefined;
	}
	return folders[0].uri.fsPath;
}
