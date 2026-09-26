import * as assert from 'assert';
import * as vscode from 'vscode';

// ─── Extension activation tests ───────────────────────────────────────────────
//
// These tests verify that the BobGraph extension activates and registers its
// three commands correctly. Ported from Front's bobgraph/src/test/extension.test.ts
// and adapted to the real command set defined in src/extension.ts.

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('bobgraph.openVisualizer command is registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(
			commands.includes('bobgraph.openVisualizer'),
			'Expected command bobgraph.openVisualizer to be registered',
		);
	});

	test('bobgraph.generateGraph command is registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(
			commands.includes('bobgraph.generateGraph'),
			'Expected command bobgraph.generateGraph to be registered',
		);
	});

	test('bobgraph.refresh command is registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(
			commands.includes('bobgraph.refresh'),
			'Expected command bobgraph.refresh to be registered',
		);
	});
});
