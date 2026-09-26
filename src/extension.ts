import * as vscode from 'vscode';
import { GraphPanel } from './panel/graphPanel';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "bobgraph" is now active!');

	const disposable = vscode.commands.registerCommand('bobgraph.openVisualizer', () => {
		GraphPanel.createOrShow(context.extensionUri);
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
