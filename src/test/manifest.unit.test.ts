import * as assert from 'assert';
import { describe, it } from 'node:test';

import { readJson, readRoot, exists } from './helpers';

/**
 * These cover the wiring a fresh install depends on. Most of the bugs caught here were
 * silent: a command that appears in the palette but resolves to nothing, a walkthrough
 * pointing at a file that never shipped, a stylesheet that shadows the host theme.
 */
const pkg = readJson<any>('package.json');
const contributes = pkg.contributes;

/** The markdown body of a step, whether declared as media.markdown or contents. */
function stepMedia(step: any): string {
    const media = step.media;
    if (typeof media === 'string') {
        return media;
    }
    return media?.markdown ?? step.contents;
}

describe('package manifest', () => {
    it('is not still the extension scaffold', () => {
        assert.notStrictEqual(pkg.name, 'vscode-extension-template');
        assert.ok(pkg.publisher, 'publisher is required or `vsce package` fails');
        assert.ok(pkg.engines?.vscode, 'engines.vscode is required');
    });

    it('has no duplicate top-level keys', () => {
        // JSON.parse silently keeps the last duplicate, so a stray second "categories"
        // looks fine in every check while the file is quietly malformed.
        const raw = readRoot('package.json');
        const keys = [...raw.matchAll(/^ {2}"([A-Za-z]+)":/gm)].map((m) => m[1]);
        const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
        assert.deepStrictEqual(dupes, [], `duplicate top-level keys: ${dupes.join(', ')}`);
    });

    it('declares a license, and ships the file', () => {
        // vsce only warns; the Marketplace rejects the upload.
        assert.ok(pkg.license, 'package.json has no "license" field');
        const found = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((f) => exists(f));
        assert.ok(found, `license "${pkg.license}" declared but no LICENSE file found`);
    });

    it('competes for the native auto-open slot via featuredFor', () => {
        // There is no `showOnStartup` on a walkthrough in the real manifest schema
        // (checked against VS Code 1.139: id, title, icon, description, featuredFor,
        // when, steps). Native auto-open is gated on featuredFor matching workspace
        // folder globs, plus the user setting workbench.welcomePage.walkthroughs.openOnInstall.
        const wt = pkg.contributes.walkthroughs[0];
        assert.ok(
            !('showOnStartup' in wt),
            'showOnStartup is not a walkthrough property; it would be silently ignored'
        );
        assert.ok(
            Array.isArray(wt.featuredFor) && wt.featuredFor.includes('**'),
            'featuredFor is the only manifest lever on native auto-open'
        );
    });

    it('opens the Welcome page on install so the walkthrough is discoverable', () => {
        assert.strictEqual(
            pkg.contributes.welcomePage?.showOnStartup,
            'Walkthrough',
            'without this the walkthrough is only reachable from the palette'
        );
    });

    it('points its icon at a file that exists', () => {
        assert.ok(pkg.icon, 'no icon - the walkthrough and extension list show a generic glyph');
        assert.ok(exists(pkg.icon), `icon file missing: ${pkg.icon}`);
    });

    it('namespaces every contributed command', () => {
        for (const entry of contributes.commands) {
            assert.ok(
                entry.command.startsWith('bobai-visualizer.'),
                `${entry.command} is not namespaced`
            );
        }
    });

    it('is not titled with the scaffold boilerplate', () => {
        for (const entry of contributes.commands) {
            assert.notStrictEqual(entry.title, 'Hello World');
        }
    });

    it('registers every contributed command in the host', () => {
        // The failure mode this guards: rename a command in package.json only, and the
        // palette entry appears but silently does nothing when clicked.
        const source = readRoot('src', 'extension.ts');
        for (const entry of contributes.commands) {
            assert.ok(
                source.includes(`'${entry.command}'`),
                `extension.ts does not register ${entry.command}`
            );
        }
    });
});

describe('walkthrough', () => {
    const walkthrough = contributes.walkthroughs?.[0];

    it('is contributed', () => {
        assert.ok(walkthrough, 'no walkthroughs contributed');
    });

    it('gives every step the required media field', () => {
        // Regression: the steps originally used a made-up "content" field. VS Code logs
        // "missing media in walkthrough step" and then drops the ENTIRE walkthrough, so it
        // silently never appears - no error in the palette, just nothing.
        for (const step of walkthrough.steps) {
            assert.ok(step.media, `step "${step.id}" has no media - the walkthrough will not register`);
        }
    });

    it('uses no fields outside the walkthrough step schema', () => {
        const allowed = new Set([
            'id', 'title', 'description', 'media', 'contents',
            'when', 'completionEvents', 'isEventOptional'
        ]);
        for (const step of walkthrough.steps) {
            for (const key of Object.keys(step)) {
                assert.ok(allowed.has(key), `step "${step.id}" has unknown field "${key}"`);
            }
        }
    });

    it('ships every step file', () => {
        for (const step of walkthrough.steps) {
            assert.ok(exists(stepMedia(step)), `missing step file: ${stepMedia(step)}`);
        }
    });

    it('uses unique step ids', () => {
        const ids = walkthrough.steps.map((s: any) => s.id);
        assert.strictEqual(new Set(ids).size, ids.length);
    });

    it('references only real commands from completionEvents', () => {
        const known = new Set(contributes.commands.map((c: any) => c.command));
        for (const step of walkthrough.steps) {
            for (const event of step.completionEvents ?? []) {
                assert.ok(
                    known.has(event.replace('onCommand:', '')),
                    `${event} references an unknown command`
                );
            }
        }
    });

    it('resolves every command: link in shipped markdown', () => {
        const known = new Set(contributes.commands.map((c: any) => c.command));
        // welcomePage.contents is inline markdown; each step's content is a file path.
        const sources: string[] = [contributes.welcomePage?.contents ?? ''];
        for (const step of walkthrough.steps) {
            sources.push(readRoot(stepMedia(step)));
        }
        let found = 0;
        for (const text of sources) {
            for (const match of text.matchAll(/command:([A-Za-z0-9._-]+)/g)) {
                found++;
                assert.ok(known.has(match[1]), `command:${match[1]} does not resolve`);
            }
        }
        assert.ok(found > 0, 'no command: links found at all');
    });

    it('opens on first run', () => {
        assert.ok(contributes.welcomePage, 'no welcomePage contributed');
        assert.strictEqual(contributes.welcomePage.showOnStartup, 'Walkthrough');
    });
});

describe('theming', () => {
    const css = readRoot('media', 'style.css');
    const rootBlock = (css.match(/:root\s*\{([^}]*)\}/) ?? [, ''])[1];

    it('does not shadow the host theme variables', () => {
        // VS Code injects --vscode-editor-background and friends. Redefining any of them
        // in :root freezes the panel to one theme regardless of what the user picked.
        const shadowed = [...rootBlock.matchAll(/(--vscode-[A-Za-z-]+)\s*:/g)].map((m) => m[1]);
        assert.deepStrictEqual(shadowed, [], `style.css redefines: ${shadowed.join(', ')}`);
    });

    it('actually consumes the core host variables', () => {
        for (const variable of [
            '--vscode-editor-background',
            '--vscode-editor-foreground',
            '--vscode-errorForeground'
        ]) {
            assert.ok(css.includes(`var(${variable}`), `never uses ${variable}`);
        }
    });

    it('keeps a browser fallback on every themed variable', () => {
        // Without fallbacks the standalone browser prototype renders unstyled.
        const used = new Set([...css.matchAll(/var\((--vscode-[A-Za-z-]+)/g)].map((m) => m[1]));
        const withFallback = new Set(
            [...css.matchAll(/var\((--vscode-[A-Za-z-]+)\s*,/g)].map((m) => m[1])
        );
        const missing = [...used].filter((v) => !withFallback.has(v));
        assert.deepStrictEqual(missing, [], `no fallback: ${missing.join(', ')}`);
    });
});

describe('packaging', () => {
    const ignore = readRoot('.vscodeignore').split('\n');

    it('ships media/, or the walkthrough markdown never reaches users', () => {
        assert.ok(!ignore.some((l) => l.trim() === 'media/**'));
    });

    it('excludes the compiled test output', () => {
        assert.ok(ignore.some((l) => l.trim() === 'out/test/**'), 'out/test/** must be ignored');
    });

    it('carries no README relative links without a repository field', () => {
        // `vsce package` hard-fails on a relative link it cannot resolve.
        if (!pkg.repository) {
            assert.ok(
                !/\]\(\.\//.test(readRoot('README.md')),
                'README has a relative link but package.json has no repository'
            );
        }
    });
});

describe('active runtime', () => {
    const extensionSource = readRoot('src', 'extension.ts');
    const webviewHtml = readRoot('media', 'webview.html');

    it('exactly one command opens a graph panel', () => {
        // Guards against a second registerCommand('...openVisualizer') being added,
        // which would silently shadow or double-register the panel creation path.
        const panelCreations = [...extensionSource.matchAll(/createWebviewPanel\(/g)];
        assert.strictEqual(
            panelCreations.length,
            1,
            `expected exactly 1 createWebviewPanel call in extension.ts, found ${panelCreations.length}`
        );
    });

    it('the active webview is the Cytoscape (media/) runtime, not vis-network', () => {
        // The media/webview.html template must load Cytoscape from CDN, not vis-network.
        assert.ok(
            webviewHtml.includes('cytoscape'),
            'webview.html does not load Cytoscape — wrong runtime may be active'
        );
        assert.ok(
            !webviewHtml.includes('vis-network'),
            'webview.html loads vis-network — this is the wrong (dead) runtime'
        );
    });

    it('extension.ts opens media/webview.html, not dist/webview', () => {
        assert.ok(
            extensionSource.includes("'webview.html'"),
            'extension.ts does not reference media/webview.html'
        );
        assert.ok(
            !extensionSource.includes("dist/webview"),
            'extension.ts references dist/webview — the dead vis-network path is still wired up'
        );
    });

    it('extension.ts does not import GraphPanel (the dead vis-network runtime)', () => {
        assert.ok(
            !extensionSource.includes('graphPanel'),
            'extension.ts imports graphPanel — the dead vis-network runtime is still wired up'
        );
        assert.ok(
            !extensionSource.includes('GraphPanel'),
            'extension.ts imports GraphPanel — the dead vis-network runtime is still wired up'
        );
    });

    it('webview.js message contract matches the handler in extension.ts', () => {
        // The webview sends openFile; extension.ts must handle it.
        // Guards against renaming one side of the message without updating the other.
        const webviewJs = readRoot('media', 'webview.js');
        assert.ok(
            webviewJs.includes("type: 'openFile'"),
            "media/webview.js no longer posts type:'openFile'"
        );
        assert.ok(
            extensionSource.includes("'openFile'"),
            "extension.ts no longer handles 'openFile' messages"
        );
    });

    it('the webview runtime has no unresolved vis-network dependency', () => {
        const webviewJs = readRoot('media', 'webview.js');
        assert.ok(
            !webviewJs.includes('vis.Network') && !webviewJs.includes('vis.DataSet'),
            'media/webview.js references vis.Network — vis-network runtime code is present in the active webview'
        );
    });
});
