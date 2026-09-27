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

interface StubStyle {
    display: string;
    zoom: string;
    /** Custom properties written through setProperty, so tests can assert them. */
    props: Record<string, string>;
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
}

interface StubEl {
    id: string;
    textContent: string;
    className: string;
    innerText: string;
    /** Value of form controls; the preference inputs are <input> elements now. */
    value: string;
    style: StubStyle;
    dataset: Record<string, string>;
    children: StubEl[];
    listeners: Array<(evt?: any) => void>;
    /** Listeners keyed by event name, for firing one specific event type. */
    byEvent: Record<string, Array<(evt?: any) => void>>;
    attrs: Record<string, string>;
    classes: Set<string>;
    classList: {
        add(name: string): void;
        remove(name: string): void;
        toggle(name: string, force?: boolean): boolean;
        contains(name: string): boolean;
    };
    rect: { top: number; left: number; width: number; height: number };
    clientWidth: number;
    /** Number of times focus() was called, so focus handling can be asserted. */
    focusCalls: number;
    /** The most recent element focus() was called on. */
    focused: StubEl | null;
    blurred: boolean;
    append(...children: StubEl[]): void;
    addEventListener(event: string, cb: (evt?: any) => void): void;
    removeEventListener(event: string, cb: (evt?: any) => void): void;
    /** Fire only the listeners registered for one event name. */
    dispatch(event: string, evt?: any): void;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): { top: number; left: number; width: number; height: number };
    blur(): void;
    focus(): void;
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
        value: '',
        style: {
            display: '',
            zoom: '',
            props: {},
            setProperty(name, value) { this.props[name] = value; },
            removeProperty(name) { delete this.props[name]; }
        },
        dataset: {},
        children: [],
        listeners: [],
        byEvent: {},
        attrs: {},
        classes: new Set<string>(),
        classList: {
            add(name) { el.classes.add(name); },
            remove(name) { el.classes.delete(name); },
            toggle(name, force) {
                const on = force === undefined ? !el.classes.has(name) : force;
                if (on) { el.classes.add(name); } else { el.classes.delete(name); }
                return on;
            },
            contains(name) { return el.classes.has(name); }
        },
        rect: { top: 0, left: 0, width: 800, height: 600 },
        clientWidth: 1200,
        focusCalls: 0,
        focused: null,
        blurred: false,
        append(...children) {
            this.children.push(...children);
        },
        addEventListener(_event, cb) {
            // Element-level listeners are what the tests fire. document-level ones are
            // wired separately by the harness and are not routed through here.
            if (typeof cb === 'function') {
                this.listeners.push(cb);
                (this.byEvent[_event] ??= []).push(cb);
            }
        },
        removeEventListener(event, cb) {
            const bucket = this.byEvent[event];
            if (bucket) { this.byEvent[event] = bucket.filter((fn) => fn !== cb); }
            this.listeners = this.listeners.filter((fn) => fn !== cb);
        },
        dispatch(event, evt) {
            for (const cb of [...(this.byEvent[event] ?? [])]) { cb(evt); }
        },
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
        getBoundingClientRect() { return { ...this.rect }; },
        blur() { this.blurred = true; },
        focus() { this.focusCalls++; this.focused = this; },
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
    /** Elements the harness exposes by class selector, e.g. `.sidebar-right`. */
    classEls: Record<string, StubEl>;
    /** The <body> stub, used to assert the drag cursor class. */
    bodyEl: StubEl;
    fetches: string[];
    useCalls: unknown[];
    layoutsUsed: string[];
    lastElements: any[];
    lastStyle: any[];
    handlers: Record<string, (evt: any) => void>;
    cytoscapeOptions: any[];
    /** Messages posted to the extension host via window.vscode.postMessage. */
    postMessages: any[];
    /** Latest value written through window.vscode.setState. */
    getSavedState(): any;
    tap(): void;
    dbltap(): void;
    hasTapHandler(): boolean;
    fire(id: string): void;
    /** Dispatch a window-level event, e.g. 'pointermove' while a drag is active. */
    windowEvent(event: string, evt?: any): void;
    /** How many times the Cytoscape instance was told to resize. */
    resizeCalls(): number;
    /** Live Cytoscape style rules, keyed by selector, after font-size updates. */
    styleRules: Record<string, Record<string, any>>;
    /** How many times the style sheet was told to redraw. */
    styleUpdateCalls(): number;
    /** Snapshot of the state persisted through window.vscode.setState. */
    savedState(): any;
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
    /** Seeded into the webview state API, to exercise layout restore. */
    savedState?: Record<string, unknown>;
    /** document.documentElement.clientWidth, used by the right-panel drag. */
    viewportWidth?: number;
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
    for (const id of [
        'cy', 'breadcrumb', 'breadcrumbText', 'nodeInfo', 'backBtn', 'refreshBtn', 'exportBtn',
        'zoomInBtn', 'zoomOutBtn', 'zoomFitBtn',
        // Panel layout: toggles, the two horizontal separators, the vertical one,
        // and the help overlay with its close button.
        'toggleLeftBtn', 'toggleRightBtn', 'leftResizer', 'rightResizer', 'detailsResizer',
        'helpBtn', 'helpOverlay', 'helpCloseBtn',
        // Preference displays are <input> elements now.
        'scaleDisplay', 'fontDisplay'
    ]) {
        els[id] = makeEl(id);
    }

    // The UI-scale / font-size code reaches the sidebars by class, not id.
    const classEls: Record<string, StubEl> = {};
    for (const cls of ['app-container', 'sidebar-left', 'sidebar-right']) {
        const el = makeEl(cls);
        el.className = cls;
        classEls[cls] = el;
    }

    const fetches: string[] = [];
    const useCalls: unknown[] = [];
    const layoutsUsed: string[] = [];
    const handlers: Record<string, (evt: any) => void> = {};
    const cytoscapeOptions: any[] = [];
    let resizeCalls = 0;

    /**
     * Minimal stand-in for Cytoscape's live style sheet. Each selector keeps the
     * properties last written to it, which is what the font-size tests inspect
     * after the preference changes on an already-rendered graph.
     */
    const styleRules: Record<string, Record<string, any>> = {};
    let styleUpdateCalls = 0;
    const styleSheet = {
        selector(selector: string) {
            return {
                style(props: Record<string, any>) {
                    if (!styleRules[selector]) { styleRules[selector] = {}; }
                    Object.assign(styleRules[selector], props);
                }
            };
        },
        update() { styleUpdateCalls++; }
    };
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
                layout: () => ({ run() { /* no animation in tests */ } }),
                // Called whenever the panel layout changes; without it the stub
                // throws and hides the layout assertions behind the failure.
                resize() { resizeCalls++; },
                // The live style sheet, so a font-size change made after the
                // graph was built can be asserted.
                style: () => styleSheet
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

    // Window-level listeners, so the drag-to-resize flow (pointerdown on a
    // separator, then pointermove/pointerup on window) is drivable in tests.
    const windowListeners: Record<string, Array<(evt?: any) => void>> = {};

    // acquireVsCodeApi() always supplies the state API in the real host, so the
    // stub must too. Without getState, webview.js throws at IIFE init and takes
    // the whole sandbox down with it.
    let savedState: any = {};

    // Seeded into the stub so the load path that restores a previous layout is
    // exercised, not just the first-run defaults.
    const initialState: any = {};
    if (options.savedState) { Object.assign(initialState, options.savedState); }
    if (Object.keys(initialState).length > 0) { savedState = { ...initialState }; }

    // SandboxHTMLElement lets makeEl() produce instances that pass `instanceof HTMLElement`
    // inside the sandbox, so the click-handler's `event.target instanceof HTMLElement` guard
    // does not silently drop every Open in IDE click in tests.
    class SandboxHTMLElement {}

    // <body> and <html> exist because the drag handlers toggle a cursor class on
    // the body and measure the right sidebar against the viewport width.
    const bodyEl = makeEl('body');
    const documentElementEl = makeEl('html');
    documentElementEl.clientWidth = options.viewportWidth ?? 1200;

    const sandbox: any = {
        // The real console is passed through so an unexpected throw is visible instead of
        // being swallowed by a no-op stub. A silent catch once hid a real regression.
        console,
        document: {
            body: bodyEl,
            documentElement: documentElementEl,
            getElementById: (id: string) => els[id] ?? null,
            querySelector: (selector: string) => classEls[selector.replace(/^\./, '')] ?? null,
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
            addEventListener(event: string, cb: (evt?: any) => void) {
                if (typeof cb === 'function') {
                    (windowListeners[event] ??= []).push(cb);
                }
            },
            // The drag handlers unregister their move/up listeners on pointerup.
            removeEventListener(event: string, cb: (evt?: any) => void) {
                const bucket = windowListeners[event];
                if (bucket) { windowListeners[event] = bucket.filter((fn) => fn !== cb); }
            },
            MOCK_DATA_URI: 'https://x/media/workspace-graph.json',
            vscode: {
                postMessage: (msg: any) => postMessages.push(msg),
                getState: () => savedState,
                setState: (next: any) => { savedState = { ...next }; }
            }
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
        classEls,
        bodyEl,
        fetches,
        useCalls,
        layoutsUsed,
        lastElements,
        lastStyle,
        handlers,
        cytoscapeOptions,
        postMessages,
        getSavedState: () => savedState,
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
        clickOpenInIde: () => {            const nodeInfo = els.nodeInfo;
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
        },
        /** Dispatch a window-level event, e.g. 'pointermove' during a drag. */
        windowEvent: (event: string, evt?: any) => {
            for (const cb of [...(windowListeners[event] ?? [])]) { cb(evt); }
        },
        resizeCalls: () => resizeCalls,
        styleRules,
        styleUpdateCalls: () => styleUpdateCalls,
        savedState: () => ({ ...savedState })
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

    it('includes file metadata when a flowchart node is clicked', async () => {
        // Flowchart nodes are not in the host's workspace-node map. The metadata lets the
        // host resolve the source file and request the same explanation as workspace nodes.
        const h = run();
        await settle();
        h.tapNodeWith({
            id: 'line-4',
            label: 'const result = run()',
            type: 'method',
            filePath: 'src/todo-app.js',
            line: 4,
            pseudocode: ''
        });
        const click = h.postMessages.find((message) => message.type === 'nodeClicked');
        assert.deepStrictEqual(
            click && { ...click },
            {
                type: 'nodeClicked',
                nodeId: 'line-4',
                filePath: 'src/todo-app.js',
                label: 'const result = run()',
                line: 4
            }
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

    it('allows nodes to be repositioned without removing click handlers', async () => {
        const h = run();
        await settle();
        const opts = h.cytoscapeOptions[0];
        assert.strictEqual(
            opts.autoungrabify,
            false,
            'nodes must be grabbable so users can reposition them'
        );
        assert.strictEqual(opts.pixelRatio, 2, 'Cytoscape should use a stable high-resolution backing store');
        assert.strictEqual(opts.textureOnViewport, false, 'zoom should render labels instead of scaling a cached texture');
        assert.strictEqual(opts.motionBlur, false, 'motion blur should never soften graph text');
        assert.strictEqual(opts.hideEdgesOnViewport, false, 'edges should remain rendered during viewport changes');
        assert.strictEqual(opts.hideLabelsOnViewport, false, 'labels should remain rendered during viewport changes');
    });

    it('configures workspace physics to repel nearby nodes', async () => {
        const h = run();
        await settle();
        const layout = h.cytoscapeOptions[0]?.layout;
        assert.strictEqual(layout.name, 'cose');
        assert.ok(layout.nodeRepulsion >= 9000, 'workspace nodes need a strong repulsion field');
        assert.ok(layout.nodeOverlap >= 30, 'workspace layout should reserve space around nodes');
        assert.ok(layout.idealEdgeLength >= 140, 'workspace edges need room between connected nodes');
    });

    it('uses a vertical flowchart layout without shrinking the initial view', async () => {
        const h = run();
        await settle();
        h.dbltap();
        await settle();
        const layout = h.cytoscapeOptions[h.cytoscapeOptions.length - 1]?.layout;
        assert.strictEqual(layout.name, 'dagre');
        assert.strictEqual(layout.rankDir, 'TB');
        assert.strictEqual(layout.fit, false);
    });

    it('renders process nodes as green rectangles and decisions as diamonds', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        const styles = new Map(
            h.lastStyle
                .filter((rule: any) => /^node\[type="/.test(rule.selector ?? ''))
                .map((rule: any) => [rule.selector, rule.style])
        );
        assert.strictEqual(styles.get('node[type="method"]')?.shape, 'rectangle');
        assert.strictEqual(styles.get('node[type="function"]')?.shape, 'rectangle');
        assert.strictEqual(styles.get('node[type="method"]')?.['background-color'], '#14532d');
        assert.strictEqual(styles.get('node[type="function"]')?.['background-color'], '#14532d');
        assert.strictEqual(styles.get('node[type="decision"]')?.shape, 'diamond');
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

    it('accepts label as the canonical display field without a repair warning', async () => {
        const h = run({
            model: {
                nodes: [{ id: 'a', label: 'a.js', type: 'file' }],
                edges: []
            }
        });
        await settle();
        assert.strictEqual(h.els.nodeInfo.children.length, 0, 'canonical labels should not show repair warnings');
    });

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

describe('panel layout', () => {
    const appVars = (h: Harness) => h.classEls['app-container'].style.props;

    it('writes the default track sizes on first run', async () => {
        const h = run();
        await settle();
        const vars = appVars(h);
        assert.strictEqual(vars['--w-left'], '240px');
        assert.strictEqual(vars['--w-right'], '300px');
        assert.strictEqual(vars['--details-h'], '55%');
    });

    it('restores a previously saved layout', async () => {
        const h = run({ savedState: { leftWidth: 333, rightWidth: 411, detailsPct: 30 } });
        await settle();
        const vars = appVars(h);
        assert.strictEqual(vars['--w-left'], '333px');
        assert.strictEqual(vars['--w-right'], '411px');
        assert.strictEqual(vars['--details-h'], '30%');
    });

    it('clamps out-of-range saved values instead of trusting them', async () => {
        const h = run({ savedState: { leftWidth: 5, rightWidth: 99_999, detailsPct: -40 } });
        await settle();
        const vars = appVars(h);
        assert.strictEqual(vars['--w-left'], '180px', 'too small should clamp to PANEL_MIN');
        assert.strictEqual(vars['--w-right'], '560px', 'too large should clamp to PANEL_MAX');
        assert.strictEqual(vars['--details-h'], '15%', 'negative percentage should clamp to DETAILS_MIN');
    });

    it('falls back to defaults when the saved value is not a number', async () => {
        const h = run({ savedState: { leftWidth: 'wide', rightWidth: null } });
        await settle();
        const vars = appVars(h);
        assert.strictEqual(vars['--w-left'], '240px');
        assert.strictEqual(vars['--w-right'], '300px');
    });

    it('restores a panel that was hidden when the window was closed', async () => {
        const h = run({ savedState: { leftHidden: true, rightHidden: true } });
        await settle();
        const vars = appVars(h);
        assert.strictEqual(vars['--w-left'], '0px');
        assert.strictEqual(vars['--w-right'], '0px');
        assert.ok(h.classEls['app-container'].classList.contains('is-collapsed-left'));
        assert.ok(h.classEls['app-container'].classList.contains('is-collapsed-right'));
    });

    it('hides the left panel on toggle and persists it', async () => {
        const h = run();
        await settle();
        h.fire('toggleLeftBtn');

        assert.strictEqual(appVars(h)['--w-left'], '0px');
        assert.ok(h.classEls['app-container'].classList.contains('is-collapsed-left'));
        assert.strictEqual(h.els.toggleLeftBtn.getAttribute('aria-pressed'), 'false');
        assert.strictEqual(h.savedState().leftHidden, true);
    });

    it('restores the left panel width when shown again', async () => {
        const h = run({ savedState: { leftWidth: 320 } });
        await settle();
        h.fire('toggleLeftBtn');
        assert.strictEqual(appVars(h)['--w-left'], '0px');

        h.fire('toggleLeftBtn');
        assert.strictEqual(appVars(h)['--w-left'], '320px', 'the previous width must come back, not the default');
        assert.ok(!h.classEls['app-container'].classList.contains('is-collapsed-left'));
        assert.strictEqual(h.els.toggleLeftBtn.getAttribute('aria-pressed'), 'true');
        assert.strictEqual(h.savedState().leftHidden, false);
    });

    it('hides the right panel on toggle and persists it', async () => {
        const h = run();
        await settle();
        h.fire('toggleRightBtn');

        assert.strictEqual(appVars(h)['--w-right'], '0px');
        assert.ok(h.classEls['app-container'].classList.contains('is-collapsed-right'));
        assert.strictEqual(h.els.toggleRightBtn.getAttribute('aria-pressed'), 'false');
        assert.strictEqual(h.savedState().rightHidden, true);
    });

    it('tells Cytoscape to resize after a toggle', async () => {
        const h = run();
        await settle();
        const before = h.resizeCalls();
        h.fire('toggleLeftBtn');
        assert.ok(h.resizeCalls() > before, 'a collapsed panel leaves the canvas at its old size');
    });

    describe('drag to resize', () => {
        const pointerDown = (h: Harness, id: string, clientX: number, clientY = 0) =>
            h.els[id].dispatch('pointerdown', { button: 0, clientX, clientY, preventDefault() { /* no-op */ } });

        it('left panel width follows the pointer', async () => {
            const h = run();
            await settle();
            pointerDown(h, 'leftResizer', 200);
            h.windowEvent('pointermove', { clientX: 350 });
            assert.strictEqual(appVars(h)['--w-left'], '350px');
        });

        it('right panel widens as its left edge moves left', async () => {
            const h = run({ viewportWidth: 1200 });
            await settle();
            // The right panel's left edge is at 1200 - 300 = 900 by default.
            pointerDown(h, 'rightResizer', 900);
            h.windowEvent('pointermove', { clientX: 800 });
            assert.strictEqual(appVars(h)['--w-right'], '400px', 'edge at 800 of a 1200px viewport means 400px wide');
        });

        it('clamps a drag to the allowed range', async () => {
            const h = run({ viewportWidth: 1200 });
            await settle();
            pointerDown(h, 'leftResizer', 200);
            h.windowEvent('pointermove', { clientX: 5 });
            assert.strictEqual(appVars(h)['--w-left'], '180px', 'should stop at the minimum width');

            h.windowEvent('pointermove', { clientX: 5000 });
            assert.strictEqual(appVars(h)['--w-left'], '560px', 'should stop at the maximum width');
        });

        it('marks the body while dragging and clears it on release', async () => {
            const h = run();
            await settle();
            pointerDown(h, 'leftResizer', 200);
            assert.ok(h.bodyEl.classList.contains('is-resizing'), 'cursor should change for the whole page while dragging');

            h.windowEvent('pointerup', {});
            assert.ok(!h.bodyEl.classList.contains('is-resizing'), 'cursor must be restored on release');
        });

        it('stops responding to the pointer after release', async () => {
            const h = run();
            await settle();
            pointerDown(h, 'leftResizer', 200);
            h.windowEvent('pointerup', {});
            h.windowEvent('pointermove', { clientX: 400 });
            assert.strictEqual(appVars(h)['--w-left'], '240px', 'the drag should be over');
        });

        it('saves the layout when the drag ends, not on every frame', async () => {
            const h = run();
            await settle();
            pointerDown(h, 'leftResizer', 200);
            h.windowEvent('pointermove', { clientX: 350 });
            assert.strictEqual(h.savedState().leftWidth, undefined, 'mid-drag state should not be persisted');

            h.windowEvent('pointerup', {});
            assert.strictEqual(h.savedState().leftWidth, 350);
        });

        it('ignores a non-primary button', async () => {
            const h = run();
            await settle();
            h.els.leftResizer.dispatch('pointerdown', { button: 2, clientX: 400, preventDefault() { /* no-op */ } });
            h.windowEvent('pointermove', { clientX: 400 });
            assert.strictEqual(appVars(h)['--w-left'], '240px', 'right-click must not start a drag');
        });

        it('the details divider sets the Node Details share of the sidebar', async () => {
            const h = run();
            await settle();
            h.classEls['sidebar-right'].rect = { top: 0, left: 0, width: 300, height: 600 };

            pointerDown(h, 'detailsResizer', 900, 0);
            h.windowEvent('pointermove', { clientY: 300 });
            assert.strictEqual(appVars(h)['--details-h'], '50%', '300 of 600px is half the sidebar');

            h.windowEvent('pointermove', { clientY: 180 });
            assert.strictEqual(appVars(h)['--details-h'], '30%', 'dragging up should give Node Details less room');
        });

        it('the details divider ignores moves when the sidebar has no height', async () => {
            const h = run();
            await settle();
            h.classEls['sidebar-right'].rect = { top: 0, left: 0, width: 300, height: 0 };

            pointerDown(h, 'detailsResizer', 900, 0);
            h.windowEvent('pointermove', { clientY: 300 });
            assert.strictEqual(appVars(h)['--details-h'], '55%', 'a collapsed sidebar must not divide by zero');
        });
    });

    describe('keyboard access', () => {
        it('arrow keys resize the left panel', async () => {
            const h = run();
            await settle();
            h.els.leftResizer.dispatch('keydown', { key: 'ArrowRight', preventDefault() { /* no-op */ } });
            assert.strictEqual(appVars(h)['--w-left'], '256px');
            assert.strictEqual(h.savedState().leftWidth, 256, 'a keyboard resize should persist immediately');
        });

        it('arrow keys resize the details divider', async () => {
            const h = run();
            await settle();
            h.els.detailsResizer.dispatch('keydown', { key: 'ArrowLeft', preventDefault() { /* no-op */ } });
            assert.strictEqual(appVars(h)['--details-h'], '53%');
        });

        it('ignores keys that are not arrows', async () => {
            const h = run();
            await settle();
            h.els.leftResizer.dispatch('keydown', { key: 'Enter', preventDefault() { /* no-op */ } });
            assert.strictEqual(appVars(h)['--w-left'], '240px');
        });
    });
});

describe('help overlay', () => {
    it('is closed until the help button is used', async () => {
        const h = run();
        await settle();
        assert.ok(!h.els.helpOverlay.classList.contains('is-open'));
    });

    it('opens from the help button', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        assert.ok(h.els.helpOverlay.classList.contains('is-open'));
    });

    it('closes from the close button', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        h.fire('helpCloseBtn');
        assert.ok(!h.els.helpOverlay.classList.contains('is-open'));
    });

    it('closes when the backdrop is clicked', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        h.els.helpOverlay.dispatch('click', { target: h.els.helpOverlay });
        assert.ok(!h.els.helpOverlay.classList.contains('is-open'));
    });

    it('stays open when the card inside the backdrop is clicked', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        h.els.helpOverlay.dispatch('click', { target: makeEl('help-card') });
        assert.ok(h.els.helpOverlay.classList.contains('is-open'), 'a click on the content must not dismiss the help');
    });

    it('closes on Escape', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        assert.ok(h.els.helpOverlay.classList.contains('is-open'));

        h.els.helpOverlay.dispatch('keydown', { key: 'Escape', preventDefault() { /* no-op */ } });
        assert.ok(!h.els.helpOverlay.classList.contains('is-open'), 'Escape is the expected way out of a dialog');
    });

    it('ignores other keys', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        h.els.helpOverlay.dispatch('keydown', { key: 'Enter', preventDefault() { /* no-op */ } });
        assert.ok(h.els.helpOverlay.classList.contains('is-open'));
    });

    it('is hidden from assistive tech while closed', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        assert.strictEqual(h.els.helpOverlay.getAttribute('aria-hidden'), 'false');

        h.fire('helpCloseBtn');
        assert.strictEqual(h.els.helpOverlay.getAttribute('aria-hidden'), 'true');
    });

    it('starts hidden from assistive tech', () => {
        // Set in the markup, so the dialog is never announced before it opens.
        assert.match(readMedia('webview.html'), /id="helpOverlay"[^>]*aria-hidden="true"/s);
    });

    it('moves focus to Close on open and back to the trigger on close', async () => {
        const h = run();
        await settle();
        h.fire('helpBtn');
        assert.ok(h.els.helpCloseBtn.focusCalls > 0, 'focus should land inside the dialog');

        h.fire('helpCloseBtn');
        assert.ok(h.els.helpBtn.focusCalls > 0, 'focus should return to the button that opened it');
    });

    it('does not steal focus on load', async () => {
        const h = run();
        await settle();
        assert.strictEqual(h.els.helpBtn.focusCalls, 0, 'yanking focus at startup strands the user');
        assert.strictEqual(h.els.helpCloseBtn.focusCalls, 0);
    });
});

describe('interaction affordances', () => {
    it('gives every interactive control a keyboard focus ring', () => {
        const css = readMedia('style.css');
        assert.match(css, /:focus-visible/, 'without a focus ring a keyboard user cannot see where they are');
    });

    it('respects a reduced-motion preference', () => {
        const css = readMedia('style.css');
        assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    });

    it('replaces the default scrollbars', () => {
        const css = readMedia('style.css');
        assert.match(css, /::-webkit-scrollbar-thumb/);
        assert.match(css, /scrollbar-width:\s*thin/);
    });

    it('keeps the separator hit area wider than the line it draws', () => {
        const css = readMedia('style.css');
        const width = css.match(/\.panel-resizer\s*\{[^}]*width:\s*(\d+)px/);
        assert.ok(width, 'the horizontal separator must declare a width');
        assert.ok(Number(width![1]) >= 8, 'a 2px grab target is too thin to drag reliably');
    });

    it('declares the separator width exactly once', () => {
        // A later rule silently overriding the width is how the hit area got
        // downgraded to 7px once already; the cascade hides it from the test
        // above, which only reads the first declaration.
        const css = readMedia('style.css');
        const widths = [...css.matchAll(/\.panel-resizer\s*\{[^}]*?width:\s*\d+px/gs)];
        assert.strictEqual(widths.length, 1, `found ${widths.length} .panel-resizer width declarations; they should be consolidated into one rule`);
    });

    it('never forwards an internal style key to Cytoscape', async () => {
        // nodeStyles carries 'font-base' so the font size can be derived; if that
        // key ever escapes into a style rule, Cytoscape rejects the whole sheet.
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        for (const rule of h.lastStyle) {
            assert.ok(
                !('font-base' in (rule.style ?? {})),
                `${rule.selector} leaked the internal font-base key into the style sheet`
            );
        }
    });

    it('passes every live style update as a property map', async () => {
        // cy.style().selector(x).style('name', value) and .style({...}) disagree on
        // what the object form produces; the codebase must use one shape only.
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        h.els.fontDisplay.value = '16';
        h.els.fontDisplay.dispatch('input');

        for (const [selector, rule] of Object.entries(h.styleRules)) {
            for (const [key, value] of Object.entries(rule)) {
                assert.ok(
                    typeof key === 'string' && (typeof value === 'number' || typeof value === 'string'),
                    `${selector} received a non-map style argument, spreading garbage keys`
                );
            }
        }
        assert.ok(Object.keys(h.styleRules).length > 0, 'no style rules were updated at all');
    });

    it('shows a resting line on the separators so they are discoverable', () => {
        const css = readMedia('style.css');
        // Previously the line only appeared on hover, which hides the affordance.
        assert.doesNotMatch(
            css.match(/\.panel-resizer::after,\s*\.panel-resizer-v::after\s*\{[^}]*\}/)?.[0] ?? '',
            /background:\s*transparent/,
            'a separator with no resting line is invisible until hovered'
        );
    });

    it('labels the AI assistant as needing a language model', () => {
        // The panel is empty on first run, so the help has to explain why.
        const html = readMedia('webview.html');
        assert.match(html, /AI Assistant/);
    });
});

describe('preference inputs', () => {
    it('shows the default scale and font size in the editable fields', async () => {
        const h = run();
        await settle();
        assert.strictEqual(h.els.scaleDisplay.value, '100');
        assert.strictEqual(h.els.fontDisplay.value, '12');
    });

    it('applies a scale typed into the field', async () => {
        const h = run();
        await settle();
        h.els.scaleDisplay.value = '150';
        h.els.scaleDisplay.dispatch('input');

        assert.strictEqual(h.classEls['sidebar-left'].style.zoom, '1.5');
        assert.strictEqual(h.classEls['sidebar-right'].style.zoom, '1.5');
        assert.strictEqual(h.savedState().uiScale, 150);
    });

    it('applies a font size typed into the field', async () => {
        const h = run();
        await settle();
        h.els.fontDisplay.value = '18';
        h.els.fontDisplay.dispatch('input');

        assert.strictEqual(h.classEls['sidebar-right'].style.props['--ai-font-size'], '18px');
        assert.strictEqual(h.savedState().aiFontSize, 18);
    });

    it('flags an out-of-range value and leaves the applied setting alone', async () => {
        const h = run();
        await settle();
        h.els.scaleDisplay.value = '500';
        h.els.scaleDisplay.dispatch('input');

        assert.ok(h.els.scaleDisplay.classList.contains('is-invalid'), 'an impossible value should be visibly rejected');
        assert.strictEqual(h.classEls['sidebar-left'].style.zoom, '1', 'the last good value must stay in effect');
    });

    it('flags a non-numeric value', async () => {
        const h = run();
        await settle();
        h.els.fontDisplay.value = 'big';
        h.els.fontDisplay.dispatch('input');

        assert.ok(h.els.fontDisplay.classList.contains('is-invalid'));
    });

    it('restores the last good value on blur', async () => {
        const h = run();
        await settle();
        h.els.scaleDisplay.value = '999';
        h.els.scaleDisplay.dispatch('input');
        h.els.scaleDisplay.dispatch('blur');

        assert.strictEqual(h.els.scaleDisplay.value, '100');
        assert.ok(!h.els.scaleDisplay.classList.contains('is-invalid'));
    });

    it('stays quiet while the field is empty mid-edit', async () => {
        const h = run();
        await settle();
        h.els.scaleDisplay.value = '';
        h.els.scaleDisplay.dispatch('input');

        assert.ok(!h.els.scaleDisplay.classList.contains('is-invalid'), 'clearing the box to retype is not an error');
        assert.strictEqual(h.classEls['sidebar-left'].style.zoom, '1');
    });

    it('Enter commits the typed value by blurring the field', async () => {
        const h = run();
        await settle();
        h.els.fontDisplay.value = '16';
        h.els.fontDisplay.dispatch('input');
        h.els.fontDisplay.dispatch('keydown', { key: 'Enter', preventDefault() { /* no-op */ } });

        assert.ok(h.els.fontDisplay.blurred, 'Enter should move focus on');
        assert.strictEqual(h.savedState().aiFontSize, 16);
    });

    it('restores saved preferences', async () => {
        const h = run({ savedState: { uiScale: 80, aiFontSize: 15 } });
        await settle();
        assert.strictEqual(h.els.scaleDisplay.value, '80');
        assert.strictEqual(h.els.fontDisplay.value, '15');
        assert.strictEqual(h.classEls['sidebar-left'].style.zoom, '0.8');
        assert.strictEqual(h.classEls['sidebar-right'].style.props['--ai-font-size'], '15px');
    });

    it('saves a whole layout snapshot, keeping unrelated state', async () => {
        const h = run({ savedState: { breadcrumbTrail: ['src'] } });
        await settle();
        h.fire('toggleRightBtn');
        const state = h.savedState();
        assert.deepStrictEqual(state.breadcrumbTrail, ['src'], 'a preference write must not drop other saved state');
        assert.ok('leftWidth' in state && 'detailsPct' in state);
    });

    it('does not zoom the whole page, which would break canvas hit-testing', async () => {
        const h = run();
        await settle();
        h.els.scaleDisplay.value = '120';
        h.els.scaleDisplay.dispatch('input');

        assert.strictEqual(h.bodyEl.style.zoom, '', 'zooming <body> shifts the canvas away from the pointer');
        assert.strictEqual(h.classEls['app-container'].style.zoom, '', 'zooming the grid container cuts off the right panel');
        assert.strictEqual(h.classEls['sidebar-left'].style.zoom, '1.2', 'the sidebars are the only thing that should scale');
    });
});

describe('graph and flowchart text sizing', () => {
    /** The style rules webview.js handed to Cytoscape for typed nodes. */
    const nodeStyle = (h: Harness, type: string) => {
        const rule = h.lastStyle.find((r: any) => r.selector === `node[type="${type}"]`);
        return rule?.style;
    };

    it('keeps the design sizes at the default font size', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        assert.strictEqual(nodeStyle(h, 'file')['font-size'], 12);
        assert.strictEqual(nodeStyle(h, 'property')['font-size'], 10);
    });

    it('scales node labels when the graph is built at a larger font', async () => {
        const h = run({ model: workspaceWithEveryType(), savedState: { aiFontSize: 18 } });
        await settle();
        assert.strictEqual(nodeStyle(h, 'file')['font-size'], 18);
        assert.strictEqual(nodeStyle(h, 'decision')['font-size'], 17, '11px scales to 16.5, rounded to 17');
        assert.strictEqual(nodeStyle(h, 'property')['font-size'], 15);
    });

    it('preserves the size hierarchy between node types', async () => {
        const h = run({ model: workspaceWithEveryType(), savedState: { aiFontSize: 20 } });
        await settle();
        const file = nodeStyle(h, 'file')['font-size'];
        const decision = nodeStyle(h, 'decision')['font-size'];
        const property = nodeStyle(h, 'property')['font-size'];
        assert.ok(file > decision, 'a 12px caption must not end up the same size as an 11px one');
        assert.ok(decision > property);
    });

    it('scales edge labels too', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        const edge = h.lastStyle.find((r: any) => r.selector === 'edge');
        assert.strictEqual(edge?.style['font-size'], '9px');

        const big = run({ model: workspaceWithEveryType(), savedState: { aiFontSize: 20 } });
        await settle();
        const bigEdge = big.lastStyle.find((r: any) => r.selector === 'edge');
        assert.strictEqual(bigEdge?.style['font-size'], '15px');
    });

    it('grows the node box so bigger labels are not clipped', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        assert.strictEqual(nodeStyle(h, 'file').width, 140);

        const big = run({ model: workspaceWithEveryType(), savedState: { aiFontSize: 18 } });
        await settle();
        assert.strictEqual(nodeStyle(big, 'file').width, 210, '140px sized for 12px text must grow with the text');
        assert.strictEqual(nodeStyle(big, 'file').height, 75);
    });

    it('updates an already-rendered graph when the font size changes', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        h.els.fontDisplay.value = '20';
        h.els.fontDisplay.dispatch('input');

        assert.strictEqual(h.styleRules['node[type="file"]']['font-size'], 20);
        assert.strictEqual(h.styleRules['node[type="file"]'].width, 233, '140 * 20/12 = 233');
        assert.strictEqual(h.styleRules.edge['font-size'], '15px');
    });

    it('redraws the canvas after rewriting the style rules', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        const before = h.styleUpdateCalls();
        h.els.fontDisplay.value = '16';
        h.els.fontDisplay.dispatch('input');
        assert.ok(h.styleUpdateCalls() > before, 'a style change with no redraw leaves stale text on the canvas');
    });

    it('shrinks the graph text along with the AI panel', async () => {
        const h = run({ model: workspaceWithEveryType() });
        await settle();
        h.els.fontDisplay.value = '9';
        h.els.fontDisplay.dispatch('input');

        assert.strictEqual(h.styleRules['node[type="file"]']['font-size'], 9);
        assert.strictEqual(h.classEls['sidebar-right'].style.props['--ai-font-size'], '9px');
    });

    it('never drops the graph text below a readable size', async () => {
        // 6px is the floor in scaledFont; the preference minimum is 9px, so this
        // only guards the clamp itself.
        const h = run({ model: workspaceWithEveryType(), savedState: { aiFontSize: 1 } });
        await settle();
        assert.ok(nodeStyle(h, 'property')['font-size'] >= 6, 'labels must stay legible');
    });

    it('clamps a nonsense saved font size back into range', async () => {
        const h = run({ savedState: { aiFontSize: 900 } });
        await settle();
        assert.strictEqual(h.els.fontDisplay.value, '20');
    });

    it('renders flowchart nodes at the chosen size', async () => {
        // The flowchart is the same renderer, so a flowchart-only fixture with a
        // saved font size must come out scaled.
        const h = run({
            model: {
                nodes: [
                    { id: 's', name: 'Start', type: 'start_end' },
                    { id: 'p', name: 'Step', type: 'process' },
                    { id: 'e', name: 'End', type: 'end' }
                ],
                edges: []
            },
            savedState: { aiFontSize: 20 }
        });
        await settle();
        assert.strictEqual(nodeStyle(h, 'start_end')['font-size'], 20);
        assert.strictEqual(nodeStyle(h, 'start_end').width, 183);
    });
});
