/**
 * Graph provider interface — the single seam between BobGraph and any
 * analysis back-end (IBM Bob, mock, or future alternatives).
 *
 * The active provider is set at activation time via setGraphProvider().
 * Tests substitute a deterministic MockGraphProvider before calling
 * executeGenerateWorkspaceGraph() so no network, process, or FS side-effect
 * is required.
 */

import type { GraphData } from './bob/graphStore';
import { generateBobGraph, runBobNodeExplanation } from './bob/bobAdapter';

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * A graph provider is responsible for:
 *   1. Analysing the workspace and returning a GraphData payload (or unknown
 *      data that will be validated before writing).
 *   2. Producing a natural-language explanation for a single node's source file.
 *
 * The real IBM Bob provider will replace MockGraphProvider once the API
 * contract is confirmed. See src/bob/bobAdapter.ts for the open questions.
 */
export interface GraphProvider {
    /**
     * Analyse the workspace rooted at `workspaceRoot` and return the graph
     * data. The return value is `unknown` because the host validates it with
     * validateGraph() before writing — providers are not trusted to produce a
     * correct schema.
     *
     * May throw any error; the caller wraps it in a user-facing message.
     *
     * @param workspaceRoot  Absolute path to the workspace root directory.
     */
    generateWorkspaceGraph(workspaceRoot: string): Promise<unknown>;

    /**
     * Return a natural-language explanation for the source file at `filePath`.
     *
     * @param filePath       Absolute path to the source file.
     * @param workspaceRoot  Absolute path to the workspace root directory.
     */
    explainNode(filePath: string, workspaceRoot: string): Promise<string>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

let _provider: GraphProvider | undefined;

/**
 * Set the active graph provider. Called once at activation time.
 * Tests call this before each scenario to inject a deterministic stub.
 */
export function setGraphProvider(provider: GraphProvider): void {
    _provider = provider;
}

/**
 * Return the active graph provider.
 * Throws if no provider has been registered yet.
 */
export function getGraphProvider(): GraphProvider {
    if (!_provider) {
        throw new Error(
            'No graph provider has been registered. ' +
            'Call setGraphProvider() before using the graph pipeline.',
        );
    }
    return _provider;
}

// ─── Mock provider ────────────────────────────────────────────────────────────

/**
 * Deterministic graph provider for tests and offline demos.
 *
 * generateWorkspaceGraph() always returns a two-node, one-edge graph whose
 * filePaths are workspace-relative. The output is deliberately minimal so
 * tests do not depend on large fixtures.
 *
 * The optional `overrides` argument lets a test customise the returned value
 * to exercise error paths (e.g. pass an invalid graph, or throw an error).
 */
export class MockGraphProvider implements GraphProvider {
    private readonly _graphOverride: unknown | undefined;
    private readonly _throwMessage: string | undefined;
    private readonly _delayMs: number;

    /**
     * @param options.graphOverride  If set, generateWorkspaceGraph returns this
     *                               value instead of the default valid graph.
     * @param options.throwMessage   If set, generateWorkspaceGraph throws an
     *                               Error with this message.
     * @param options.delayMs        Simulated async delay (default 0).
     */
    constructor(options: {
        graphOverride?: unknown;
        throwMessage?: string;
        delayMs?: number;
    } = {}) {
        this._graphOverride = options.graphOverride;
        this._throwMessage = options.throwMessage;
        this._delayMs = options.delayMs ?? 0;
    }

    async generateWorkspaceGraph(_workspaceRoot: string): Promise<unknown> {
        if (this._delayMs > 0) {
            await new Promise<void>(resolve => setTimeout(resolve, this._delayMs));
        }
        if (this._throwMessage !== undefined) {
            throw new Error(this._throwMessage);
        }
        if (this._graphOverride !== undefined) {
            return this._graphOverride;
        }
        return MockGraphProvider.validGraph();
    }

    async explainNode(filePath: string, _workspaceRoot: string): Promise<string> {
        return `Mock explanation for ${filePath}`;
    }

    /**
     * The canonical valid graph returned by the mock provider.
     * Tests that verify the written content compare against this.
     */
    static validGraph(): GraphData {
        return {
            nodes: [
                {
                    id: 'src/app.ts',
                    label: 'app.ts',
                    type: 'file',
                    filePath: 'src/app.ts',
                },
                {
                    id: 'src/util.ts',
                    label: 'util.ts',
                    type: 'file',
                    filePath: 'src/util.ts',
                },
            ],
            edges: [
                { from: 'src/app.ts', to: 'src/util.ts', relation: 'imports' },
            ],
        };
    }
}

/**
 * Provider backed by VS Code's Language Model API. IBM Bob can supply the
 * model when it registers itself with VS Code; no provider-specific API key is
 * handled by BobGraph.
 */
export class LanguageModelGraphProvider implements GraphProvider {
    async generateWorkspaceGraph(workspaceRoot: string): Promise<unknown> {
        return generateBobGraph(workspaceRoot);
    }

    async explainNode(filePath: string, _workspaceRoot: string): Promise<string> {
        return runBobNodeExplanation(filePath, filePath);
    }
}
