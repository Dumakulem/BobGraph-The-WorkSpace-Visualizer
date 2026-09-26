/**
 * Unit tests for resolveOpenFileRequest — the validation layer that guards
 * every "Open in IDE" click before any filesystem access occurs.
 *
 * These run under Node's built-in test runner (no VS Code instance needed).
 */

import * as assert from 'assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { resolveOpenFileRequest, OpenFileValidationError } from '../openFile';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * A workspace root that exists on this machine and is normalised for the
 * current OS, so path.resolve / path.normalize comparisons work correctly.
 */
const WORKSPACE = path.normalize(os.tmpdir());

function resolve(filePath: unknown, line: unknown = 1, workspace: string | undefined = WORKSPACE) {
    return resolveOpenFileRequest(filePath, line, workspace);
}

// ── no workspace ─────────────────────────────────────────────────────────────

describe('resolveOpenFileRequest — no workspace', () => {
    it('throws when workspaceRoot is undefined', () => {
        // Call directly — the resolve() helper has a default for workspace, so explicitly
        // passing undefined would activate that default rather than testing the undefined case.
        assert.throws(
            () => resolveOpenFileRequest('src/foo.ts', 1, undefined),
            OpenFileValidationError,
        );
    });

    it('error message names the problem', () => {
        let msg = '';
        try { resolveOpenFileRequest('src/foo.ts', 1, undefined); } catch (e) { msg = (e as Error).message; }
        assert.match(msg, /no workspace/i);
    });
});

// ── invalid filePath ─────────────────────────────────────────────────────────

describe('resolveOpenFileRequest — invalid filePath', () => {
    it('throws for undefined filePath', () => {
        assert.throws(() => resolve(undefined), OpenFileValidationError);
    });

    it('throws for null filePath', () => {
        assert.throws(() => resolve(null), OpenFileValidationError);
    });

    it('throws for a number filePath', () => {
        assert.throws(() => resolve(42), OpenFileValidationError);
    });

    it('throws for an empty string', () => {
        assert.throws(() => resolve(''), OpenFileValidationError);
    });

    it('throws for a whitespace-only string', () => {
        assert.throws(() => resolve('   '), OpenFileValidationError);
    });

    it('error message names the problem', () => {
        let msg = '';
        try { resolve(''); } catch (e) { msg = (e as Error).message; }
        assert.match(msg, /empty|missing/i);
    });
});

// ── absolute paths ────────────────────────────────────────────────────────────

describe('resolveOpenFileRequest — absolute paths', () => {
    it('throws for a POSIX absolute path', () => {
        assert.throws(() => resolve('/etc/passwd'), OpenFileValidationError);
    });

    it('throws for a Windows-style absolute path', () => {
        assert.throws(() => resolve('C:\\Windows\\System32'), OpenFileValidationError);
    });

    it('error message names the path', () => {
        let msg = '';
        try { resolve('/etc/passwd'); } catch (e) { msg = (e as Error).message; }
        assert.match(msg, /absolute/i);
    });
});

// ── path traversal ────────────────────────────────────────────────────────────

describe('resolveOpenFileRequest — path traversal', () => {
    it('throws for a leading "../" segment', () => {
        assert.throws(() => resolve('../outside.ts'), OpenFileValidationError);
    });

    it('throws for ".." after normalisation', () => {
        assert.throws(() => resolve('src/../../etc/passwd'), OpenFileValidationError);
    });

    it('error message mentions traversal', () => {
        let msg = '';
        try { resolve('../foo.ts'); } catch (e) { msg = (e as Error).message; }
        assert.match(msg, /travers/i);
    });
});

// ── outside-workspace paths ───────────────────────────────────────────────────

describe('resolveOpenFileRequest — outside workspace', () => {
    it('throws when the resolved path escapes the workspace root', () => {
        // On most platforms the tmp dir has a sibling (e.g. /var next to /tmp).
        // Build a path that would resolve to the sibling regardless of tmp location.
        const escapingPath = path.join('..', 'bobgraph-escape-test', 'file.ts')
            .replace(/\\/g, '/');
        // Only test this if the path actually resolves outside WORKSPACE — on some
        // systems os.tmpdir() is a symlink alias and normalisation may differ.
        // Use a clearly-absolute-destination workspace instead.
        const fakeWorkspace = path.join(os.tmpdir(), 'bobgraph-workspace');
        assert.throws(
            () => resolveOpenFileRequest('../outside.ts', 1, fakeWorkspace),
            OpenFileValidationError,
        );
    });

    it('error message mentions outside or workspace', () => {
        let msg = '';
        try {
            resolveOpenFileRequest('../outside.ts', 1, path.join(os.tmpdir(), 'ws'));
        } catch (e) { msg = (e as Error).message; }
        assert.match(msg, /outside|workspace/i);
    });
});

// ── valid paths ───────────────────────────────────────────────────────────────

describe('resolveOpenFileRequest — valid paths', () => {
    it('returns an absolute file path for a simple relative path', () => {
        const result = resolve('src/foo.ts', 1);
        assert.strictEqual(result.absoluteFilePath, path.join(WORKSPACE, 'src', 'foo.ts'));
    });

    it('handles a nested relative path', () => {
        const result = resolve('a/b/c.ts', 1);
        assert.strictEqual(result.absoluteFilePath, path.join(WORKSPACE, 'a', 'b', 'c.ts'));
    });

    it('accepts a single filename with no directory', () => {
        const result = resolve('index.ts', 1);
        assert.strictEqual(result.absoluteFilePath, path.join(WORKSPACE, 'index.ts'));
    });

    it('absoluteFilePath starts with the workspace root', () => {
        const result = resolve('src/foo.ts', 5);
        assert.ok(
            result.absoluteFilePath.startsWith(WORKSPACE),
            `${result.absoluteFilePath} should start with ${WORKSPACE}`
        );
    });
});

// ── line number normalisation ─────────────────────────────────────────────────

describe('resolveOpenFileRequest — line number', () => {
    it('returns the supplied valid line', () => {
        assert.strictEqual(resolve('src/a.ts', 42).line, 42);
    });

    it('returns 1 when line is 0', () => {
        assert.strictEqual(resolve('src/a.ts', 0).line, 1);
    });

    it('returns 1 when line is negative', () => {
        assert.strictEqual(resolve('src/a.ts', -5).line, 1);
    });

    it('returns 1 when line is a non-finite number (NaN)', () => {
        assert.strictEqual(resolve('src/a.ts', NaN).line, 1);
    });

    it('returns 1 when line is Infinity', () => {
        assert.strictEqual(resolve('src/a.ts', Infinity).line, 1);
    });

    it('returns 1 when line is undefined', () => {
        assert.strictEqual(resolve('src/a.ts', undefined).line, 1);
    });

    it('returns 1 when line is null', () => {
        assert.strictEqual(resolve('src/a.ts', null).line, 1);
    });

    it('returns 1 when line is a string', () => {
        assert.strictEqual(resolve('src/a.ts', '5').line, 1);
    });

    it('floors a fractional line number', () => {
        assert.strictEqual(resolve('src/a.ts', 3.9).line, 3);
    });

    it('accepts line 1', () => {
        assert.strictEqual(resolve('src/a.ts', 1).line, 1);
    });
});

// ── message contract ──────────────────────────────────────────────────────────

describe('resolveOpenFileRequest — message contract', () => {
    it('succeeds on the exact shape the webview sends', () => {
        // This is the message the webview posts:
        // { type: 'openFile', filePath: 'src/foo.ts', line: 1 }
        // resolveOpenFileRequest receives filePath and line.
        const result = resolveOpenFileRequest('src/extension.ts', 5, WORKSPACE);
        assert.ok(result.absoluteFilePath);
        assert.strictEqual(result.line, 5);
    });

    it('OpenFileValidationError is an instance of Error', () => {
        try {
            resolve('', 1);
        } catch (e) {
            assert.ok(e instanceof Error);
            assert.ok(e instanceof OpenFileValidationError);
        }
    });
});
