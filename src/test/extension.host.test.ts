import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Host-side tests. These need a real VS Code instance, so they are kept separate from the
 * fast unit suites and only run via `npm run test:integration` - that runner downloads
 * VS Code on first use.
 */
suite('Extension activation', () => {
    vscode.window.showInformationMessage('Running BOB AI extension tests.');

    test('activates and registers all commands', async () => {
        const extension = vscode.extensions.getExtension('bob-ai-team.bobai-visualizer');
        assert.ok(extension, 'extension not found - is the publisher still "bob-ai-team"?');

        await extension.activate();
        assert.strictEqual(extension.isActive, true);

        const commands = await vscode.commands.getCommands(true);
        for (const id of [
            'bobai-visualizer.openVisualizer',
            'bobai-visualizer.showGettingStarted',
            'bobai-visualizer.generateGraph',
            'bobai-visualizer.refreshGraph',
            'bobgraph.openVisualizer',
            'bobgraph.generateGraph',
            'bobgraph.refresh',
        ]) {
            assert.ok(commands.includes(id), `${id} is not registered`);
        }
    });

    test('the walkthrough command resolves to the contributed walkthrough', async () => {
        // Guards the exact bug documented in ARCHITECTURE.md section 8: a command id that
        // exists in package.json but was never registered, so the palette entry did nothing.
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('bobai-visualizer.showGettingStarted'));
    });
});
