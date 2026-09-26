import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveOpenFileRequest, OpenFileValidationError } from './openFile';
import { checkActiveLanguageModel, getGraphProvider, LanguageModelGraphProvider, setGraphProvider } from './graphProvider';
import { readGraph, writeGraph, GraphFileNotFoundError, GraphValidationError } from './bob/graphStore';
import { resolveNodeFilePath } from './bob/explainNode';
import { runBobAgentQuestion } from './bob/bobAdapter';

/**
 * Extension host. Owns the webview panel, asset URI injection, and file-opening requests.
 * See ARCHITECTURE.md for the full picture.
 *
 * Security notes (from fix/scaffold-hardening):
 * - Asset URIs are injected via asWebviewUri — no file:// or relative paths.
 * - The CSP in webview.html allows only the CDNs actually used and the webview origin.
 * - acquireVsCodeApi() is called once and parked on window.vscode.
 * - MOCK_DATA_URI is injected as a JSON-encoded string so the webview can fetch sample data.
 *
 * Security notes (Open in IDE):
 * - filePath from the webview is never trusted as an absolute path.
 * - resolveOpenFileRequest validates and resolves the path before any FS call.
 * - Absolute paths, ".." traversal, and out-of-workspace paths are all rejected.
 */

/**
 * The active webview panel, if one is open. Tracked so that
 * executeGenerateWorkspaceGraph can push a loadModel message after writing.
 * Set to undefined when the panel is disposed.
 */
let activePanel: vscode.WebviewPanel | undefined;
let activeGraphNodes = new Map<string, { filePath: string; label: string }>();
const GRAPH_PROVIDER_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`provider timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export function activate(context: vscode.ExtensionContext) {
    const WALKTHROUGH_ID = 'bobaiVisualizer.gettingStarted';
    setGraphProvider(new LanguageModelGraphProvider());

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
                'Welcome to BobGraph - Workspace Visualizer. Take the 2-minute tour?',
                'Start Tour',
                'Not Now'
            )
            .then(choice => {
                if (choice === 'Start Tour') {
                    void showGettingStarted();
                }
            });
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.openVisualizer', () => {
            // Sandbox: the webview may only read files under media/, and never via file:// or
            // relative paths. asWebviewUri is the only way to reference a local asset.
            const panel = vscode.window.createWebviewPanel(
                'bobVisualizer',
                'BobGraph - Workspace Visualizer',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
                }
            );

            activePanel = panel;
            panel.onDidDispose(() => {
                if (activePanel === panel) {
                    activePanel = undefined;
                }
            }, null, context.subscriptions);

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
                    if (message.type === 'openFile') {
                        handleOpenFile(message.filePath, message.line);
                    } else if (message.type === 'requestGraph') {
                        void sendCurrentGraph(panel);
                    } else if (message.type === 'nodeClicked' && typeof message.nodeId === 'string') {
                        void sendNodeExplanation(
                            panel,
                            message.nodeId,
                            typeof message.filePath === 'string' ? message.filePath : undefined
                        );
                    } else if (message.type === 'requestFlowchart' && typeof message.nodeId === 'string') {
                        void sendNodeFlowchart(panel, message.nodeId);
                    } else if (message.type === 'agentQuestion' && typeof message.nodeId === 'string') {
                        void sendAgentQuestion(
                            panel,
                            message.nodeId,
                            typeof message.filePath === 'string' ? message.filePath : undefined,
                            message.question,
                        );
                    }
                },
                undefined,
                context.subscriptions
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'bobai-visualizer.generateWorkspaceGraph',
            () => {
                void executeGenerateWorkspaceGraph();
            }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('bobai-visualizer.checkAiConnection', async () => {
            try {
                const models = await checkActiveLanguageModel();
                void vscode.window.showInformationMessage(`BobGraph language model connection is available: ${models}`);
            } catch (error) {
                void vscode.window.showErrorMessage(
                    `BobGraph language model connection is unavailable: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        })
    );
}

/**
 * Handles an openFile message from the webview.
 *
 * Validates the path, resolves it relative to the workspace root, and opens the
 * file at the requested line. Shows an error notification on any failure.
 *
 * Extracted from the activate closure so it can be tested independently.
 */
export function handleOpenFile(filePath: unknown, rawLine: unknown): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let request;
    try {
        request = resolveOpenFileRequest(filePath, rawLine, workspaceRoot);
    } catch (error) {
        if (error instanceof OpenFileValidationError) {
            void vscode.window.showErrorMessage(error.message);
        } else {
            void vscode.window.showErrorMessage(
                `Cannot open file: unexpected error — ${String(error)}`
            );
        }

        return;
    }

    const { absoluteFilePath, line } = request;
    // line is 1-based from the webview; VS Code Range uses 0-based.
    const targetLine = line - 1;

    vscode.workspace.openTextDocument(vscode.Uri.file(absoluteFilePath)).then(
        doc => vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(targetLine, 0, targetLine, 0)
        }),
        err => {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(
                `Cannot open "${absoluteFilePath}": ${msg}`
            );
        }

    );
}

async function sendCurrentGraph(panel: vscode.WebviewPanel): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        await panel.webview.postMessage({
            type: 'graphError',
            message: 'Cannot load the workspace graph: no workspace folder is open.',
        });
        return;
    }

    try {
        const graph = await readGraph(workspaceRoot);
        activeGraphNodes = new Map(graph.nodes.map(node => [node.id, node]));
        await panel.webview.postMessage({ type: 'loadModel', payload: graph });
    } catch (error) {
        const message = error instanceof GraphFileNotFoundError
            ? error.message
            : error instanceof GraphValidationError
                ? `Graph validation failed: ${error.message}`
                : `Unable to load the workspace graph: ${String(error)}`;
        await panel.webview.postMessage({ type: 'graphError', message });
    }

}

async function sendNodeExplanation(
    panel: vscode.WebviewPanel,
    nodeId: string,
    fallbackFilePath?: string
): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const node = activeGraphNodes.get(nodeId);
    const filePath = node?.filePath ?? fallbackFilePath;
    if (!workspaceRoot || !filePath) {
        await panel.webview.postMessage({
            type: 'graphError',
            nodeId,
            message: `Unable to explain node "${nodeId}". Refresh the graph and try again.`,
        });
        return;
    }

    try {
        const resolvedFilePath = resolveNodeFilePath(workspaceRoot, filePath);
        const provider = getGraphProvider();
        const modelName = await provider.getModelName();
        await panel.webview.postMessage({ type: 'explanationLoading', nodeId, modelName });
        const summary = await provider.explainNode(resolvedFilePath, workspaceRoot, nodeId);
        await panel.webview.postMessage({ type: 'nodeExplanation', nodeId, summary, modelName });
    } catch (error) {
        await panel.webview.postMessage({
            type: 'graphError',
            nodeId,
            message: `Unable to explain node "${nodeId}": ${String(error)}`,
        });
    }

}

async function sendNodeFlowchart(panel: vscode.WebviewPanel, nodeId: string): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const node = activeGraphNodes.get(nodeId);
        if (!workspaceRoot || !node) {
            await panel.webview.postMessage({
                type: 'graphError',
                message: `Unable to open flowchart for "${nodeId}". Refresh the graph and try again.`,
            });
            return;
        }

        try {
            const filePath = resolveNodeFilePath(workspaceRoot, node.filePath);
            const graph = await getGraphProvider().generateFlowchart(filePath, workspaceRoot, nodeId);
            await panel.webview.postMessage({
                type: 'flowchartData',
                nodeId,
                fileName: node.label,
                graph,
            });
        } catch (error) {
            await panel.webview.postMessage({
                type: 'graphError',
                message: `Unable to open flowchart for "${nodeId}": ${String(error)}`,
            });
    }
}

async function sendAgentQuestion(
    panel: vscode.WebviewPanel,
    nodeId: string,
    fallbackFilePath: string | undefined,
    question: unknown,
): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const node = activeGraphNodes.get(nodeId);
    const filePath = node?.filePath ?? fallbackFilePath;
    if (!workspaceRoot || !filePath) {
        await panel.webview.postMessage({
            type: 'agentError',
            nodeId,
            message: 'Select a node with a source file before asking Bob a question.',
        });
        return;
    }
    if (typeof question !== 'string' || !question.trim()) {
        await panel.webview.postMessage({
            type: 'agentError',
            nodeId,
            message: 'Ask the AI assistant a question before sending.',
        });
        return;
    }

    try {
        const resolvedFilePath = resolveNodeFilePath(workspaceRoot, filePath);
        const response = await runBobAgentQuestion(
            nodeId,
            resolvedFilePath,
            question,
            modelName => {
                void panel.webview.postMessage({ type: 'agentLoading', nodeId, modelName });
            },
        );
        await panel.webview.postMessage({
            type: 'agentAnswer',
            nodeId,
            answer: response.answer,
            modelName: response.modelName,
        });
    } catch (error) {
        await panel.webview.postMessage({
            type: 'agentError',
            nodeId,
            message: `Unable to ask the AI assistant: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
}

/**
 * Executes the generate-workspace-graph pipeline:
 *   1. Require an open workspace.
 *   2. Call the active graph provider.
 *   3. Validate the response.
 *   4. Write .bobgraph/workspace-graph.json (only on valid data).
 *   5. Push a loadModel message to the active panel, if any.
 *   6. Show a success notification.
 *
 * On any failure: preserves the previous graph file, shows an error message,
 * and does NOT show a success message.
 *
 * Exported so tests can call it directly after injecting a MockGraphProvider.
 */
export async function executeGenerateWorkspaceGraph(
    options: { panel?: vscode.WebviewPanel } = {}
): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        void vscode.window.showErrorMessage(
            'BobGraph: Cannot generate workspace graph — no workspace folder is open.'
        );
        return;
    }

    let provider;
    try {
        provider = getGraphProvider();
    } catch (err) {
        void vscode.window.showErrorMessage(
            `BobGraph: No graph provider is available. ${err instanceof Error ? err.message : String(err)}`
        );
        return;
    }

    let rawGraph: unknown;
    try {
        rawGraph = await withTimeout(
            provider.generateWorkspaceGraph(workspaceRoot),
            GRAPH_PROVIDER_TIMEOUT_MS,
        );
    } catch (err) {
        void vscode.window.showErrorMessage(
            `BobGraph: Graph generation failed. ${err instanceof Error ? err.message : String(err)}`
        );
        return;
    }

    try {
        // writeGraph validates before writing, so an invalid response never
        // touches the file. The previous graph is preserved on any error.
        await writeGraph(workspaceRoot, rawGraph);
    } catch (err) {
        if (err instanceof GraphValidationError) {
            void vscode.window.showErrorMessage(
                `BobGraph: The generated graph is invalid and was not saved. ${err.message}`
            );
        } else {
            void vscode.window.showErrorMessage(
                `BobGraph: Failed to save the workspace graph. ${err instanceof Error ? err.message : String(err)}`
            );
        }
        return;
    }

    // Refresh the active panel (either the one passed in for tests, or the
    // module-level reference set by openVisualizer).
    const panel = options.panel ?? activePanel;
    if (panel) {
        void panel.webview.postMessage({ type: 'loadModel', payload: rawGraph });
    }

    void vscode.window.showInformationMessage(
        'BobGraph: Workspace graph generated successfully.'
    );
}

export function deactivate() {}
