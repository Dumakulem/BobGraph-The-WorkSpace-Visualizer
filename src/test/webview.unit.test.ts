import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, it } from 'node:test';

import { MEDIA } from './helpers';

const SOURCE = path.join(MEDIA, 'webview.js');

/**
 * Runs the real webview.js inside a stubbed DOM so its async state machine can be driven
 * from Node. This is where the bugs that matter actually lived: a tap handler that was
 * never registered, a failed drill-down that wedged the view, a Refresh button that no-opped.
 */

interface StubEl {
    id: string;
    textContent: string;
    className: string;
    innerText: string;
    style: { display: string };
    dataset: Record<string, string>;
    children: StubEl[];
    listeners: Array<() => void>;
    append(...children: StubEl[]): void;
    addEventListener(event: string, cb: () => void): void;
    fire(): void;
    matches(): boolean;
}

function makeEl(id: string): StubEl {
    return {
        id,
        textContent: '',
        className: '',
        innerText: '',
        style: { display: '' },
        dataset: {},
        children: [],
        listeners: [],
        append(...children) {
            this.children.push(...children);
        },
        addEventListener(event, cb) {
            // Element-level listeners are what the tests fire. document-level ones are
            // wired separately by the harness and are not routed through here.
            if (typeof cb === 'function') {
                this.listeners.push(cb);
            }
        },
        fire() {
            this.listeners.forEach((cb) => cb());
        },
        matches() {
            return false;
        }
    };
}

interface Harness {
    els: Record<string, StubEl>;
    fetches: string[];
    useCalls: unknown[];
    layoutsUsed: string[];
    tap(): void;
    hasTapHandler(): boolean;
    fire(id: string): void;
}

interface Options {
    flowchartFails?: boolean;
    dagrePlugin?: 'ok' | 'missing' | 'noDagreLib';
    nodeCount?: number;
    model?: unknown;
    realCytoscape?: boolean;
}

function run(options: Options = {}): Harness {
    const { flowchartFails = false, dagrePlugin = 'ok', nodeCount = 1, model } = options;

    const els: Record<string, StubEl> = {};
    for (const id of ['cy', 'breadcrumb', 'breadcrumbText', 'nodeInfo', 'backBtn', 'refreshBtn']) {
        els[id] = makeEl(id);
    }

    const fetches: string[] = [];
    const useCalls: unknown[] = [];
    const layoutsUsed: string[] = [];
    let tapHandler: ((evt: any) => void) | null = null;
    let domReady: (() => void) | null = null;

    const cytoscape = Object.assign(
        function (opts: any) {
            layoutsUsed.push(opts.layout.name);
            return {
                destroy() { /* replaced between renders */ },
                on(event: string, selector: string, cb: (evt: any) => void) {
                    if (event === 'tap' && selector === 'node') {
                        tapHandler = cb;
                    }
                },
                layout: () => ({ run() { /* no animation in tests */ } })
            };
        },
        {
            use(plugin: unknown) {
                useCalls.push(plugin);
            }
        }
    );

    const workspaceModel = {
        nodes: Array.from({ length: nodeCount }, (_, i) => ({
            id: `file${i}`,
            name: `file${i}.js`,
            type: 'file',
            flowchart: 'todo-app',
            filePath: `src/file${i}.js`,
            line: 1,
            pseudocode: 'p'
        })),
        edges: []
    };

    const sandbox: any = {
        // The real console is passed through so an unexpected throw is visible instead of
        // being swallowed by a no-op stub. A silent catch once hid a real regression.
        console,
        document: {
            getElementById: (id: string) => els[id] ?? null,
            createElement: () => makeEl('new'),
            addEventListener: (event: string, cb: () => void) => {
                if (event === 'DOMContentLoaded') {
                    domReady = cb;
                }
            }
        },
        window: { addEventListener() { /* host messages unused here */ }, MOCK_DATA_URI: 'https://x/media/workspace-graph.json' },
        HTMLElement: class { },
        cytoscape,
        fetch: async (uri: string) => {
            fetches.push(uri);
            if (flowchartFails && uri.includes('/flowcharts/')) {
                throw new Error('TypeError: Failed to fetch');
            }
            return { ok: true, json: async () => model ?? workspaceModel };
        },
        JSON, Math, Object, String, Number,
        AbortController, setTimeout, clearTimeout
    };

    if (dagrePlugin === 'ok') {
        sandbox.cytoscapeDagre = { name: 'cytoscapeDagre-plugin' };
    }
    if (dagrePlugin !== 'noDagreLib') {
        sandbox.dagre = { name: 'dagre-lib' };
    }

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });
    assert.ok(domReady, 'DOMContentLoaded handler never registered');
    (domReady as unknown as () => void)();

    const fileNode = {
        data: () => ({ id: 'file1', label: 'todo-app.js', type: 'file', flowchart: 'todo-app', filePath: 'src/todo-app.js', line: 1, pseudocode: 'p' })
    };

    return {
        els,
        fetches,
        useCalls,
        layoutsUsed,
        hasTapHandler: () => typeof tapHandler === 'function',
        tap: () => {
            assert.ok(tapHandler, 'no tap handler registered - clicking a node would do nothing');
            (tapHandler as unknown as (evt: any) => void)({ target: fileNode });
        },
        fire: (id: string) => {
            const el = els[id];
            assert.ok(el, `no element #${id}`);
            assert.ok(el.listeners.length > 0, `#${id} has no click handler wired`);
            el.fire();
        }
    };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
    await tick();
    await tick();
    await tick();
};

describe('dagre wiring', () => {
    it('registers the plugin exactly once', async () => {
        const h = run();
        await settle();
        assert.strictEqual(h.useCalls.length, 1);
    });

    it('registers the plugin, not the bare dagre library', async () => {
        const h = run();
        await settle();
        assert.strictEqual((h.useCalls[0] as any).name, 'cytoscapeDagre-plugin');
    });

    it('lays flowcharts out with dagre', async () => {
        const h = run();
        await settle();
        h.tap();
        await settle();
        assert.strictEqual(h.layoutsUsed[h.layoutsUsed.length - 1], 'dagre');
    });

    it('falls back to cose instead of throwing when the plugin is missing', async () => {
        const h = run({ dagrePlugin: 'missing' });
        await settle();
        h.tap();
        await settle();
        assert.ok(h.layoutsUsed.includes('cose'), 'expected a cose fallback');
    });

    it('falls back when dagre itself is missing', async () => {
        const h = run({ dagrePlugin: 'noDagreLib' });
        await settle();
        h.tap();
        await settle();
        assert.ok(h.layoutsUsed.includes('cose'), 'expected a cose fallback');
    });
});

describe('drill-down', () => {
    it('registers a tap handler on the graph', async () => {
        // Regression: an early `return` in initGraph once sat above the cy.on('tap')
        // registration, making every node click a no-op while the panel still rendered.
        const h = run();
        await settle();
        assert.ok(h.hasTapHandler(), 'initGraph did not register the node tap handler');
    });

    it('fetches a flowchart on the first tap', async () => {
        const h = run();
        await settle();
        const before = h.fetches.length;
        h.tap();
        await settle();
        assert.ok(h.fetches.length > before, 'first tap did not fetch');
    });

    it('shows the breadcrumb on success', async () => {
        const h = run();
        await settle();
        h.tap();
        await settle();
        assert.strictEqual(h.els.breadcrumb.style.display, 'flex');
        assert.strictEqual(h.els.breadcrumbText.innerText, 'Workspace > todo-app.js');
    });

    it('commits the view state exactly once, so later taps are ignored', async () => {
        const h = run();
        await settle();
        h.tap();
        await settle();
        const after = h.fetches.length;
        h.tap();
        await settle();
        assert.strictEqual(h.fetches.length, after, 'a second tap re-drilled into the same file');
    });

    it('stays usable and retryable when the flowchart fetch fails', async () => {
        // Regression: the reported bug. currentView was set before the await, so a failure
        // left the view stuck on "flowchart" and every later click was silently dropped.
        const h = run({ flowchartFails: true });
        await settle();
        h.tap();
        await settle();
        assert.strictEqual(h.els.breadcrumb.style.display, 'none', 'breadcrumb left visible after failure');

        const afterFirst = h.fetches.length;
        h.tap();
        await settle();
        assert.ok(h.fetches.length > afterFirst, 'a retry tap was swallowed - the view state wedged');
    });

    it('offers a Retry control after a failed load', async () => {
        const h = run({ flowchartFails: true });
        await settle();
        h.tap();
        await settle();
        const hasRetry = h.els.nodeInfo.children.some((c) => c.className.includes('error-retry'));
        assert.ok(hasRetry, 'a failed load left the user with no way to retry');
    });
});

describe('refresh', () => {
    it('re-fetches the workspace graph rather than only re-laying out', async () => {
        // Regression: the handler was `if (!cy) return; cy.layout(...)`, which never
        // re-read data and did nothing at all once a load had failed.
        const h = run();
        await settle();
        const before = h.fetches.length;
        h.fire('refreshBtn');
        await settle();
        assert.ok(h.fetches.length > before, 'refresh did not re-fetch');
    });

    it('reloads the current flowchart, not the workspace', async () => {
        const h = run();
        await settle();
        h.tap();
        await settle();
        const before = h.fetches.length;
        h.fire('refreshBtn');
        await settle();
        assert.strictEqual(h.fetches.length, before + 1);
        assert.ok(h.fetches[h.fetches.length - 1].includes('/flowcharts/'), 'refresh left the flowchart view');
    });

    it('back returns to the workspace graph', async () => {
        const h = run();
        await settle();
        h.tap();
        await settle();
        h.fire('backBtn');
        await settle();
        assert.ok(
            !h.fetches[h.fetches.length - 1].includes('/flowcharts/'),
            'back did not leave the flowchart view'
        );
    });
});

describe('malformed models from the backend', () => {
    /*
     * Cytoscape is unforgiving: an edge pointing at a node that does not exist makes it
     * THROW, taking the whole graph down, and duplicate ids are merged silently so files
     * disappear with no error. sanitizeModel exists to stop the backend doing either.
     * Verified against cytoscape 3.26.0 itself.
     */
    const cases: Array<[string, unknown, RegExp]> = [
        ['nodes missing entirely', {}, /nodes/],
        ['nodes is null', { nodes: null, edges: [] }, /nodes/],
        ['edges is null', { nodes: [{ id: 'a', name: 'a.js', type: 'file' }], edges: null }, /edges/],
        ['empty model', { nodes: [], edges: [] }, /no nodes/],
        ['duplicate ids are dropped', {
            nodes: [{ id: 'a', name: 'x.js', type: 'file' }, { id: 'a', name: 'y.js', type: 'file' }],
            edges: []
        }, /duplicate node id/],
        ['dangling edge is dropped', {
            nodes: [{ id: 'a', name: 'a.js', type: 'file' }],
            edges: [{ source: 'a', target: 'ghost', relation: 'imports' }]
        }, /does not exist/],
        ['label instead of name is flagged', {
            nodes: [{ id: 'a', label: 'a.js', type: 'file' }],
            edges: []
        }, /expects "name"/],
        ['unknown node type is flagged', {
            nodes: [{ id: 'a', name: 'a.js', type: 'quantum-widget' }],
            edges: []
        }, /unrecognised node type/]
    ];

    for (const [name, model, expected] of cases) {
        it(`${name}: still builds a graph and tells the user`, async () => {
            const h = run({ model });
            await settle();
            // The critical part: a graph was constructed rather than the load blowing up.
            assert.strictEqual(h.layoutsUsed.length, 1, 'no graph was built');
            const shown = h.els.nodeInfo.children.map((c) => c.textContent).join(' | ');
            assert.match(shown, expected, `user was not told what was wrong: "${shown}"`);
        });
    }

    it('drops the dangling edge instead of letting Cytoscape throw', async () => {
        const h = run({
            model: {
                nodes: [{ id: 'a', name: 'a.js', type: 'file' }, { id: 'b', name: 'b.js', type: 'file' }],
                edges: [
                    { source: 'a', target: 'b', relation: 'imports' },
                    { source: 'a', target: 'ghost', relation: 'calls' }
                ]
            }
        });
        await settle();
        assert.strictEqual(h.layoutsUsed.length, 1);
    });
});

describe('large graphs', () => {
    it('swaps cose for grid past the node limit', async () => {
        // Regression risk: cose is a physics simulation and would lock the webview up
        // against a real workspace, with no feedback.
        const h = run({ nodeCount: 500 });
        await settle();
        assert.ok(h.layoutsUsed.includes('grid'), `expected a grid fallback, got ${h.layoutsUsed.join(', ')}`);
    });

    it('still uses cose for a normal sized graph', async () => {
        const h = run({ nodeCount: 10 });
        await settle();
        assert.strictEqual(h.layoutsUsed[0], 'cose');
    });
});
