import * as assert from 'assert';
import { describe, it } from 'node:test';

import { MEDIA, readMedia, readJson, exists } from './helpers';

const CSP_SOURCE = 'vscode-webview://f0e1d2c3';

describe('shipped JSON', () => {
    it('parses', () => {
        for (const file of ['workspace-graph.json', 'flowcharts/todo-app.json', 'flowcharts/storage-util.json']) {
            assert.doesNotThrow(() => readJson('media', file), `${file} does not parse`);
        }
    });

    it('ships no unreferenced data files', () => {
        // mock-data.json used to sit here, superseded by workspace-graph.json.
        assert.ok(!exists('media', 'mock-data.json'), 'media/mock-data.json is dead weight');
    });
});

describe('workspace graph', () => {
    const model = readJson<any>('media', 'workspace-graph.json');

    it('carries no fields the frontend ignores', () => {
        assert.ok(!JSON.stringify(model).includes('parentId'), 'parentId is never read');
    });

    it('resolves every flowchart slug to a real file', () => {
        for (const node of model.nodes) {
            assert.ok(node.flowchart, `node ${node.id} has no flowchart slug`);
            assert.ok(
                exists('media', 'flowcharts', `${node.flowchart}.json`),
                `node ${node.id} points at a missing flowchart file`
            );
        }
    });

    it('references only nodes that exist in its edges', () => {
        const ids = new Set(model.nodes.map((n: any) => n.id));
        for (const edge of model.edges) {
            assert.ok(ids.has(edge.source), `edge source ${edge.source} is not a node`);
            assert.ok(ids.has(edge.target), `edge target ${edge.target} is not a node`);
        }
    });
});

describe('flowcharts', () => {
    for (const file of ['flowcharts/todo-app.json', 'flowcharts/storage-util.json']) {
        it(`${file} is well formed`, () => {
            const model = readJson<any>('media', file);
            assert.ok(Array.isArray(model.nodes) && model.nodes.length > 0, 'no nodes');
            assert.ok(Array.isArray(model.edges), 'edges must be an array');
            const ids = new Set(model.nodes.map((n: any) => n.id));
            for (const edge of model.edges) {
                assert.ok(ids.has(edge.source), `edge source ${edge.source} is not a node`);
                assert.ok(ids.has(edge.target), `edge target ${edge.target} is not a node`);
            }
        });
    }
});

describe('content security policy', () => {
    const raw = readMedia('webview.html');
    // The host substitutes these placeholders before the page loads, so mirror that here
    // rather than asserting against the unreplaced template.
    const csp = raw
        .replaceAll('${webview.cspSource}', CSP_SOURCE)
        .match(/Content-Security-Policy" content="([^"]+)"/)?.[1];

    it('is present at all', () => {
        assert.ok(csp, 'no CSP meta tag - the webview would be refused');
    });

    it('defaults to none', () => {
        assert.ok(csp?.includes("default-src 'none'"), 'CSP should default to none');
    });

    it('allows the webview origin so local assets load', () => {
        assert.ok(csp?.includes(CSP_SOURCE), 'webview origin missing, assets will not load');
    });

    it('allows only the CDNs actually used, over https', () => {
        const hosts = [...(csp ?? '').matchAll(/https:\/\/([^/;\s]+)/g)].map((m) => m[1]);
        assert.deepStrictEqual(
            [...new Set(hosts)].sort(),
            ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com']
        );
    });

    it('does not widen script-src beyond unsafe-inline and those CDNs', () => {
        const scriptSrc = csp?.match(/script-src ([^;]+)/)?.[1] ?? '';
        assert.ok(!/http:\/\//.test(scriptSrc), 'script-src allows plaintext http');
        assert.ok(!/\*|\bdata:/.test(scriptSrc), `script-src is too permissive: ${scriptSrc}`);
    });
});

describe('webview markup', () => {
    const html = readMedia('webview.html');
    const js = readMedia('webview.js');

    it('loads dagre before the cytoscape plugin that captures it', () => {
        // Match real script tags only. The explanatory comment above them also names
        // cytoscape-dagre, so a plain indexOf on the raw HTML matches the comment first.
        const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
        const dagreLib = scripts.findIndex((s) => s.includes('dagre@0.8.5'));
        const plugin = scripts.findIndex((s) => s.includes('cytoscape-dagre'));
        assert.ok(dagreLib >= 0, 'the dagre library script tag is missing');
        assert.ok(plugin >= 0, 'the cytoscape-dagre plugin script tag is missing');
        assert.ok(
            dagreLib < plugin,
            'dagre must load first, the plugin captures window.dagre at load time'
        );
    });

    it('loads cytoscape core', () => {
        const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
        assert.ok(scripts.some((s) => s.includes('cytoscape.min.js')), 'cytoscape core is missing');
    });

    it('ships no debug cruft', () => {
        assert.ok(!html.includes('console.log'), 'debug console.log left in webview.html');
        assert.ok(!/<style>\s*<\/style>/.test(html), 'empty <style> block left behind');
    });

    it('has no enabled button without a listener', () => {
        // A visible button that does nothing reads as a bug. Controls whose backend does
        // not exist yet must carry the disabled attribute.
        const wired = new Set(
            [...js.matchAll(/getElementById\('([A-Za-z]+)'\)\??\.addEventListener/g)].map((m) => m[1])
        );
        const buttons = [...html.matchAll(/<button[^>]*id="([A-Za-z]+)"[\s\S]*?>/g)];
        assert.ok(buttons.length > 0, 'no buttons found');
        for (const [, id] of buttons) {
            const tag = buttons.find((b) => b[1] === id)![0];
            assert.ok(
                /disabled/.test(tag) || wired.has(id),
                `button #${id} is enabled with no handler`
            );
        }
    });

    it('does not imply an AI provider is connected', () => {
        assert.ok(!html.includes('Awaiting analysis request'), 'still implies a request is pending');
    });

    it('provides a scrollable chat history and dynamic model title', () => {
        assert.match(html, /id="agentTitle"/);
        assert.match(html, />AI Assistant</);
        assert.match(readMedia('style.css'), /\.agent-body\s*\{[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/);
        assert.match(readMedia('style.css'), /\.agent-messages\s*\{[\s\S]*overflow-y:\s*auto/);
        assert.match(js, /modelName/);
        assert.doesNotMatch(js, /Bob is thinking/);
        assert.match(js, /Assistant/);
        assert.doesNotMatch(js, /\$\{modelName\.trim\(\)\} Agent/);
    });
});
