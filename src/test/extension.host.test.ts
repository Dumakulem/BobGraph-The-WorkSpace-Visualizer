import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Host-side tests. These need a real VS Code instance, so they are kept separate from the
 * fast unit suites and only run via `npm run test:integration` - that runner downloads
 * VS Code on first use.
 */
suite('Extension activation', () => {
    vscode.window.showInformationMessage('Running BobGraph extension tests.');

    test('activates and registers both commands', async () => {
        const extension = vscode.extensions.getExtension('bob-ai-team.bobgraph');
        assert.ok(extension, 'extension not found - is the Marketplace extension id correct?');

        await extension.activate();
        assert.strictEqual(extension.isActive, true);

        const commands = await vscode.commands.getCommands(true);
        for (const id of [
            'bobgraph.openVisualizer',
            'bobgraph.showGettingStarted'
        ]) {
            assert.ok(commands.includes(id), `${id} is not registered`);
        }
    });

    test('the walkthrough command resolves to the contributed walkthrough', async () => {
        // Guards the exact bug documented in ARCHITECTURE.md section 8: a command id that
        // exists in package.json but was never registered, so the palette entry did nothing.
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('bobgraph.showGettingStarted'));
    });
});
