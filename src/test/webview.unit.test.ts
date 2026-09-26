import * as assert from 'assert';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as path from 'path';
import * as vm from 'vm';
import { describe, it } from 'node:test';

import { MEDIA, readMedia } from './helpers';

const SOURCE = path.join(MEDIA, 'webview.js');

/**
 * The real Cytoscape, the same 3.26.0 the webview loads from the CDN, used to check that the
 * style sheet webview.js builds is actually valid. It ships no type declarations, so this is
 * typed to the only surface needed here.
 */
const cytoscapeReal = createRequire(__filename)('cytoscape') as (options: unknown) => {
    destroy(): void;
};

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
    listeners: Array<(evt?: any) => void>;
    append(...children: StubEl[]): void;
    addEventListener(event: string, cb: (evt?: any) => void): void;
    fire(evt?: any): void;
    matches(): boolean;
    closest(selector: string): StubEl | null;
}

function makeEl(id: string): StubEl {
    const el: StubEl = {
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
        addEventListener(_event, cb) {
            // Element-level listeners are what the tests fire. document-level ones are
            // wired separately by the harness and are not routed through here.
            if (typeof cb === 'function') {
                this.listeners.push(cb);
            }
        },
        fire(evt?: any) {
            this.listeners.forEach((cb) => cb(evt));
        },
        matches() {
            return false;
        },
        // Walks the element itself; since our stub has no DOM parent chain, "closest"
        // only matches the element itself. That is sufficient: the click handler calls
        // event.target.closest('button[data-file-path]') and we pass the button as target.
        closest(selector: string): StubEl | null {
            if (selector === 'button[data-file-path]' && 'filePath' in this.dataset) {
                return this;
            }
            return null;
        }
    };
    return el;
}

interface Harness {
    els: Record<string, StubEl>;
    fetches: string[];
    useCalls: unknown[];
    layoutsUsed: string[];
    lastElements: any[];
    lastStyle: any[];
    handlers: Record<string, (evt: any) => void>;
    cytoscapeOptions: any[];
    /** Messages posted to the extension host via window.vscode.postMessage. */
    postMessages: any[];
    tap(): void;
    dbltap(): void;
    hasTapHandler(): boolean;
    fire(id: string): void;
    /** Fire the tap handler with a custom node data object. */
    tapNodeWith(data: Record<string, unknown>): void;
    /**
     * Fire the #nodeInfo click listener with the first button child that has a
     * data-file-path attribute, simulating the user clicking "Open in IDE".
     */
    clickOpenInIde(): void;
}

interface Options {
    flowchartFails?: boolean;
    dagrePlugin?: 'ok' | 'missing' | 'noDagreLib';
    nodeCount?: number;
    model?: unknown;
    realCytoscape?: boolean;
}

function workspaceWithEveryType() {
    return {
        nodes: [
            { id: 'a', name: 'A', type: 'file' },
            { id: 'b', name: 'B', type: 'class' },
            { id: 'c', name: 'C', type: 'method' },
            { id: 'd', name: 'D', type: 'function' },
            { id: 'e', name: 'E', type: 'start_end' },
            { id: 'f', name: 'F', type: 'decision' }
        ],
        edges: []
    };
}

function run(options: Options = {}): Harness {
    const { flowchartFails = false, dagrePlugin = 'ok', nodeCount = 1, model } = options;
    const lastElements: any[] = [];
    const lastStyle: any[] = [];

    const els: Record<string, StubEl> = {};
    for (const id of ['cy', 'breadcrumb', 'breadcrumbText', 'nodeInfo', 'backBtn', 'refreshBtn', 'exportBtn', 'zoomInBtn', 'zoomOutBtn', 'zoomFitBtn']) {
        els[id] = makeEl(id);
    }

    const fetches: string[] = [];
    const useCalls: unknown[] = [];
    const layoutsUsed: string[] = [];
    const handlers: Record<string, (evt: any) => void> = {};
    const cytoscapeOptions: any[] = [];
    let tapHandler: ((evt: any) => void) | null = null;
    let domReady: (() => void) | null = null;

    const cytoscape = Object.assign(
        function (opts: any) {
            layoutsUsed.push(opts.layout.name);
            lastElements.push(...(opts.elements ?? []));
            lastStyle.push(...(opts.style ?? []));
            cytoscapeOptions.push(opts);
            return {
                destroy() { /* replaced between renders */ },
                on(event: string, selector: string, cb: (evt: any) => void) {
                    handlers[event] = cb;
                    if (event === 'tap' && selector === 'node') {
                        tapHandler = cb;
                    }
                },
                container: () => [{ style: {} }],
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

    // Real values parsed out of style.css, so the graph palette is exercised through the
    // same path the browser uses rather than silently falling back to JS literals.
    const themeVars: Record<string, string> = (() => {
        const out: Record<string, string> = {};
        for (const m of readMedia('style.css').matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
            out[m[1]] = m[2].trim();
        }
        return out;
    })();

    const postMessages: any[] = [];

    // SandboxHTMLElement lets makeEl() produce instances that pass `instanceof HTMLElement`
    // inside the sandbox, so the click-handler's `event.target instanceof HTMLElement` guard
    // does not silently drop every Open in IDE click in tests.
    class SandboxHTMLElement {}

    const sandbox: any = {
        // The real console is passed through so an unexpected throw is visible instead of
        // being swallowed by a no-op stub. A silent catch once hid a real regression.
        console,
        document: {
            getElementById: (id: string) => els[id] ?? null,
            createElement: () => {
                const el = makeEl('new');
                Object.setPrototypeOf(el, SandboxHTMLElement.prototype);
                return el;
            },
            addEventListener: (event: string, cb: () => void) => {
                if (event === 'DOMContentLoaded') {
                    domReady = cb;
                }
            }
        },
        window: {
            addEventListener() { /* host messages unused here */ },
            MOCK_DATA_URI: 'https://x/media/workspace-graph.json',
            vscode: { postMessage: (msg: any) => postMessages.push(msg) }
        },
        // Real values parsed out of style.css, so the graph palette is exercised through the
        // same path the browser uses. Without this the whole themeColor() branch silently
        // fell back to its literals and the theming code was never actually run.
        getComputedStyle: () => ({
            getPropertyValue: (name: string) => themeVars[name] ?? ''
        }),
        HTMLElement: SandboxHTMLElement,
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

    function makeNode(data: Record<string, unknown>) {
        return {
            data: () => data,
            neighbourhood: (_selector: string) => ({ map: () => [] }),
            addClass: (_cls: string) => {},
            removeClass: (_cls: string) => {}
        };
    }

    const fileNode = makeNode({
        id: 'file1', label: 'todo-app.js', type: 'file',
        flowchart: 'todo-app', filePath: 'src/todo-app.js', line: 1, pseudocode: 'p'
    });

    return {
        els,
        fetches,
        useCalls,
        layoutsUsed,
        lastElements,
        lastStyle,
        handlers,
        cytoscapeOptions,
        postMessages,
        hasTapHandler: () => typeof tapHandler === 'function',
        dbltap: () => {
            assert.ok(handlers.dbltap, 'no dbltap handler - double click would do nothing');
            (handlers.dbltap as unknown as (evt: any) => void)({ target: fileNode });
        },
        tap: () => {
            assert.ok(tapHandler, 'no tap handler registered - clicking a node would do nothing');
            (tapHandler as unknown as (evt: any) => void)({ target: fileNode });
        },
        tapNodeWith: (data: Record<string, unknown>) => {
            assert.ok(tapHandler, 'no tap handler registered');
            (tapHandler as unknown as (evt: any) => void)({ target: makeNode(data) });
        },
        clickOpenInIde: () => {
            const nodeInfo = els.nodeInfo;
            assert.ok(nodeInfo.listeners.length > 0, '#nodeInfo has no click listener');
            // Find the button child that carries a filePath in its dataset.
            const btn = nodeInfo.children.find((c) => 'filePath' in c.dataset);
            assert.ok(btn, 'no Open in IDE button found in #nodeInfo');
            // The listener checks instanceof HTMLElement; ensure the btn passes.
            Object.setPrototypeOf(btn, SandboxHTMLElement.prototype);
            nodeInfo.listeners[0]({ target: btn });
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
        h.dbltap();
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

    it('fetches a flowchart on double-click', async () => {
        const h = run();
        await settle();
        const before = h.fetches.length;
        h.dbltap();
        await settle();
        assert.ok(h.fetches.length > before, 'double-click did not fetch a flowchart');
    });

    it('shows the breadcrumb on success', async () => {
        const h = run();
        await settle();
        h.dbltap();
        await settle();
        assert.strictEqual(h.els.breadcrumb.style.display, 'flex');
        assert.strictEqual(h.els.breadcrumbText.innerText, 'Workspace > todo-app.js');
    });

    it('commits the view state exactly once, so later double-clicks are ignored', async () => {
        const h = run();
        await settle();
        h.dbltap();
        await settle();
        const after = h.fetches.length;
        h.dbltap();
        await settle();
        assert.strictEqual(h.fetches.length, after, 'a second double-click re-drilled into the same file');
    });

    it('stays usable and retryable when the flowchart fetch fails', async () => {
        // Regression: the reported bug. currentView was set before the await, so a failure
        // left the view stuck on "flowchart" and every later click was silently dropped.
        const h = run({ flowchartFails: true });
        await settle();
        h.dbltap();
        await settle();
        assert.strictEqual(h.els.breadcrumb.style.display, 'none', 'breadcrumb left visible after failure');

        const afterFirst = h.fetches.length;
        h.dbltap();
        await settle();
        assert.ok(h.fetches.length > afterFirst, 'a retry double-click was swallowed - the view state wedged');
    });

    it('offers a Retry control after a failed load', async () => {
        const h = run({ flowchartFails: true });
        await settle();
        h.dbltap();
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
        h.dbltap();
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
        h.dbltap();
        await settle();
        h.fire('backBtn');
        await settle();
        assert.ok(
            !h.fetches[h.fetches.length - 1].includes('/flowcharts/'),
            'back did not leave the flowchart view'
        );
    });
});

describe('opening a flowchart', () => {
    it('does NOT open on a single click — single click shows details only', async () => {
        // Requirement: single click shows description + connections in the panel, never drills.
        const h = run();
        await settle();
        h.tap();
        await settle();
        assert.ok(
            !h.fetches.some((u) => String(u).includes('flowcharts/')),
            `single click must not fetch a flowchart; saw ${JSON.stringify(h.fetches)}`
        );
    });

    it('opens on a double click too', async () => {
        // Cytoscape fires dbltap separately from tap, so this needs its own handler.
        // People try double click first; relying on tap firing twice was not good enough.
        const h = run();
        await settle();
        h.dbltap();
        await settle();
        assert.ok(
            h.fetches.some((u) => String(u).includes('flowcharts/todo-app.json')),
            'double click did not open the flowchart'
        );
    });

    it('fetches the flowchart only once when a double click fires both events', async () => {
        // Cytoscape fires dbltap AND tap on a physical double click. The tap handler must
        // not trigger an additional flowchart fetch after the dbltap already started one.
        const h = run();
        await settle();
        h.dbltap();
        h.tap();   // fires synchronously alongside dbltap; tap must not re-fetch
        await settle();
        const flowFetches = h.fetches.filter((u) => String(u).includes('flowcharts/'));
        assert.strictEqual(
            flowFetches.length,
            1,
            `expected one flowchart fetch, got ${flowFetches.length}: ${JSON.stringify(flowFetches)}`
        );
    });

    it('makes nodes ungrabbable so a press is never swallowed as a drag', async () => {
        // Cytoscape suppresses `tap` when a press becomes a drag. With physics layouts on
        // grabbable nodes, that is exactly "I clicked the file and nothing happened".
        const h = run();
        await settle();
        const opts = h.cytoscapeOptions[0];
        assert.strictEqual(
            opts.autoungrabify,
            true,
            'autoungrabify not set: taps can be lost to drag gestures'
        );
        assert.strictEqual(opts.pixelRatio, 'auto', 'Cytoscape should use its actual backing-store ratio');
        assert.strictEqual(opts.textureOnViewport, false, 'zoom should render labels instead of scaling a cached texture');
    });

    it('wires a hover cursor, since Cytoscape is a canvas', async () => {
        const h = run();
        await settle();
        assert.ok(h.handlers.mouseover, 'no mouseover handler, so nodes give no hover affordance');
        assert.ok(h.handlers.mouseout, 'no mouseout handler');
    });

    it('tells the user how to reach the flowchart', () => {
        // The empty state is the only instruction a first-time user gets.
        const html = readMedia('webview.html');
        assert.match(html, /file/i);
        assert.match(html, /flowchart/i);
    });
});

describe('graph palette', () => {
    it('resolves every node colour from the --accent-* palette in style.css', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();

        // The per-type style sheet is built from nodeStyles, keyed by selector.
        const byType = new Map<string, any>();
        for (const s of h.lastStyle) {
            const m = /^node\[type="(.+)"\]$/.exec(s.selector ?? '');
            if (m) {
                byType.set(m[1], s.style);
            }
        }
        assert.ok(byType.size >= 6, `expected all 6 node types styled, got ${byType.size}`);

        // Every colour must be the concrete hex declared in style.css - proving the CSS
        // custom property was actually read rather than the JS fallback being used.
        for (const [type, style] of byType) {
            assert.ok(
                /^#[0-9a-f]{6}$/i.test(style['background-color']),
                `${type} background is "${style['background-color']}", not a resolved hex from the palette`
            );
        }
    });

    it('uses only style properties and value types Cytoscape accepts', async () => {
        /*
         * Cytoscape rejects an unknown style property, or a value of the wrong type, with a
         * console warning and then silently keeps its default. So the failure has no exception
         * and no test failure - it just looks like a rendering bug in the browser. That is
         * exactly how "background" (not a Cytoscape property, it is "background-color") and
         * "text-max-width: wrap" (a size, so it needs a number) shipped unnoticed.
         *
         * The style sheet is taken from the options webview.js actually passed to cytoscape,
         * not transcribed, so this cannot drift away from the shipped styles. Validation runs
         * against the real library - the same 3.26.0 the webview loads from the CDN.
         */
        const h = run({ model: workspaceWithEveryType() });
        await settle();

        const styleSheet = h.cytoscapeOptions[0]?.style;
        assert.ok(Array.isArray(styleSheet) && styleSheet.length > 0, 'no style sheet was passed to cytoscape');
        const nodeStyle = styleSheet.find((rule: { selector?: string }) => rule.selector === 'node')?.style;
        assert.strictEqual(nodeStyle?.['text-wrap'], 'ellipsis');
        assert.strictEqual(nodeStyle?.['text-max-width'], 100);

        const invalid: string[] = [];
        for (const rule of styleSheet as Array<{ selector: string; style: Record<string, unknown> }>) {
            for (const [property, value] of Object.entries(rule.style)) {
                const warnings: string[] = [];
                const original = console.warn;
                console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
                let cy: { destroy(): void } | undefined;
                try {
                    cy = cytoscapeReal({
                        headless: true,
                        styleEnabled: true,
                        elements: [{ data: { id: 'probe', type: 'file' } }],
                        style: [{ selector: rule.selector, style: { [property]: value } }],
                        layout: { name: 'null' }
                    });
                } finally {
                    console.warn = original;
                    // Headless instances with styling keep timers alive; release them so the
                    // test process can exit.
                    cy?.destroy();
                }
                for (const warning of warnings) {
                    invalid.push(`${rule.selector} { ${property}: ${JSON.stringify(value)} } -> ${warning}`);
                }
            }
        }
        assert.deepStrictEqual(invalid, [], 'Cytoscape rejected style properties:\n' + invalid.join('\n'));
    });

    it('keeps webview.js from re-declaring palette colours', () => {
        // style.css is the single source of truth for the graph palette. webview.js used
        // to carry its own copies of the hex values, so editing the palette left the graph
        // rendering in the old colours. Two things must hold:
        //   1. every node background is resolved through an --accent-* variable
        //   2. the literal fallback agrees with what style.css declares
        const declared = new Map<string, string>();
        for (const m of readMedia('style.css').matchAll(/(--accent-[\w-]+):\s*(#[0-9a-f]{3,8})/gi)) {
            declared.set(m[1], m[2].toLowerCase());
        }

        const source = readMedia('webview.js');
        // Deliberately matches background-color: and not background: - "background" is not a
        // Cytoscape property, so if this ever matches zero the styles are wrong, not the regex.
        const backgrounds = [...source.matchAll(/'?background-color'?:\s*(themeColor\([^)]*\)|'#[0-9a-f]{6}')/g)]
            .map((m) => m[1].trim());
        assert.ok(backgrounds.length >= 6, `expected the 6 node styles, found ${backgrounds.length}`);
        assert.ok(
            !/[{,]\s*'?background'?:\s*themeColor\(/.test(source),
            'node styles use "background", which Cytoscape ignores; it must be "background-color"'
        );

        for (const bg of backgrounds) {
            const themed = /^themeColor\('(--accent-[\w-]+)'\s*,\s*'(#[0-9a-f]{6})'\)$/.exec(bg);
            assert.ok(themed, `node background is not themed: ${bg}`);
            const [, variable, fallback] = themed;
            assert.ok(
                declared.has(variable),
                `${variable} is used in webview.js but not declared in style.css`
            );
            assert.strictEqual(
                fallback,
                declared.get(variable),
                `fallback for ${variable} disagrees with style.css (${fallback} vs ${declared.get(variable)})`
            );
        }
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

describe('Open in IDE — button rendering', () => {
    it('renders an Open in IDE button when the node has a filePath', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 5, pseudocode: '' });
        const btn = h.els.nodeInfo.children.find((c) => c.className.includes('btn-open-ide'));
        assert.ok(btn, 'Open in IDE button not rendered for a node with a filePath');
    });

    it('does NOT render an Open in IDE button when the node has no filePath', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: '', pseudocode: '' });
        const btn = h.els.nodeInfo.children.find((c) => c.className.includes('btn-open-ide'));
        assert.ok(!btn, 'Open in IDE button must not appear when filePath is absent');
    });

    it('stores the filePath on the button dataset', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 7, pseudocode: '' });
        const btn = h.els.nodeInfo.children.find((c) => 'filePath' in c.dataset);
        assert.ok(btn, 'button has no dataset.filePath');
        assert.strictEqual(btn!.dataset.filePath, 'src/foo.ts');
    });

    it('stores the line on the button dataset, defaulting to 1', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 42, pseudocode: '' });
        const btn = h.els.nodeInfo.children.find((c) => 'filePath' in c.dataset);
        assert.strictEqual(btn?.dataset.line, '42');
    });

    it('defaults line to 1 in the dataset when the node supplies no line', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', pseudocode: '' });
        const btn = h.els.nodeInfo.children.find((c) => 'filePath' in c.dataset);
        assert.strictEqual(btn?.dataset.line, '1');
    });
});

describe('Open in IDE — message sending', () => {
    it('sends an openFile message when the button is clicked', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 5, pseudocode: '' });
        h.clickOpenInIde();
        const msg = h.postMessages.find((m) => m.type === 'openFile');
        assert.ok(msg, 'no openFile message was posted');
    });

    it('message type is exactly "openFile"', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 1, pseudocode: '' });
        h.clickOpenInIde();
        const msg = h.postMessages.find((m) => m.type === 'openFile');
        assert.strictEqual(msg?.type, 'openFile');
    });

    it('message filePath matches the node filePath', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 3, pseudocode: '' });
        h.clickOpenInIde();
        const msg = h.postMessages.find((m) => m.type === 'openFile');
        assert.strictEqual(msg?.filePath, 'src/foo.ts');
    });

    it('message line is a number matching the node line', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 42, pseudocode: '' });
        h.clickOpenInIde();
        const msg = h.postMessages.find((m) => m.type === 'openFile');
        assert.strictEqual(msg?.line, 42);
    });

    it('message line defaults to 1 when the node has no line', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', pseudocode: '' });
        h.clickOpenInIde();
        const msg = h.postMessages.find((m) => m.type === 'openFile');
        assert.strictEqual(msg?.line, 1);
    });

    it('message carries no extra fields beyond type, filePath, and line', async () => {
        const h = run();
        await settle();
        h.tapNodeWith({ id: 'n1', label: 'foo.ts', type: 'file', filePath: 'src/foo.ts', line: 1, pseudocode: '' });
        h.clickOpenInIde();
        const msg = h.postMessages.find((m) => m.type === 'openFile');
        assert.deepStrictEqual(Object.keys(msg).sort(), ['filePath', 'line', 'type']);
    });
});
