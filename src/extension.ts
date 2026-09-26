import * as vscode from 'vscode';
import { GraphPanel } from './panel/graphPanel';
import { runBobGraphGeneration } from './bob/bobAdapter';
import { ensureGraphDir, graphFilePath } from './bob/graphStore';

export function activate(context: vscode.ExtensionContext) {
	// Store the extension URI once so all commands can access it.
	GraphPanel.setExtensionUri(context.extensionUri);

	// ── Open the visualizer ───────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('bobgraph.openVisualizer', () => {
			GraphPanel.createOrShow(context.extensionUri);
		}),
	);

	// ── Refresh: reload the graph file into the open panel ───────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('bobgraph.refresh', () => {
			void GraphPanel.refresh();
		}),
	);

	// ── Generate: ask Bob to analyse the workspace and write the JSON file ───
	context.subscriptions.push(
		vscode.commands.registerCommand('bobgraph.generateGraph', () => {
			void runGenerateGraph();
		}),
	);
}

async function runGenerateGraph(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		void vscode.window.showErrorMessage(
			'BobGraph: No workspace folder is open. Open a folder first.',
		);
		return;
	}
	const workspaceRoot = folders[0].uri.fsPath;

	// Ensure the .bobgraph directory exists before Bob writes into it.
	await ensureGraphDir(workspaceRoot);
	const outFile = graphFilePath(workspaceRoot);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'BobGraph: Generating workspace graph…',
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
					// createOrShow reads extensionUri from the static property set at
					// activation time — the workspaceRoot must not be passed here.
					GraphPanel.createOrShow();
				}
			} catch (error) {
				void vscode.window.showErrorMessage(`BobGraph: ${String(error)}`);
			}
		},
	);
}

export function deactivate() {}
