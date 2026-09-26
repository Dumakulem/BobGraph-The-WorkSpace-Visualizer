import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

// Import pure graph-building functions from graphBuilder — no vscode dependency.
import {
	buildNodesFromScannedFiles,
	inferEdgesDeterministic,
} from '../bob/graphBuilder';
import type { WorkspaceFile } from '../bob/workspaceScanner';
import { writeGraph, readGraph } from '../bob/graphStore';

// ─── buildNodesFromScannedFiles ───────────────────────────────────────────────

describe('buildNodesFromScannedFiles', () => {
	it('creates one node per scanned file', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/index.ts', ext: 'ts' },
			{ relativePath: 'src/utils.ts', ext: 'ts' },
			{ relativePath: 'README.md', ext: 'md' },
		];
		const nodes = buildNodesFromScannedFiles(files);
		assert.strictEqual(nodes.length, 3);
	});

	it('sets id and filePath to the relative path', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/foo.ts', ext: 'ts' },
		];
		const [node] = buildNodesFromScannedFiles(files);
		assert.strictEqual(node.id, 'src/foo.ts');
		assert.strictEqual(node.filePath, 'src/foo.ts');
	});

	it('sets label to the file basename', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/panel/graphPanel.ts', ext: 'ts' },
		];
		const [node] = buildNodesFromScannedFiles(files);
		assert.strictEqual(node.label, 'graphPanel.ts');
	});

	it('sets type to "file" for every node', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'a.ts', ext: 'ts' },
			{ relativePath: 'b.py', ext: 'py' },
		];
		const nodes = buildNodesFromScannedFiles(files);
		for (const n of nodes) {
			assert.strictEqual(n.type, 'file');
		}
	});

	it('produces no absolute paths in id or filePath', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/ext.ts', ext: 'ts' },
		];
		const [node] = buildNodesFromScannedFiles(files);
		assert.ok(!path.isAbsolute(node.id), 'id should not be absolute');
		assert.ok(!path.isAbsolute(node.filePath), 'filePath should not be absolute');
	});
});

// ─── inferEdgesDeterministic ──────────────────────────────────────────────────

describe('inferEdgesDeterministic', () => {
	it('returns empty edges when there are no snippets', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/a.ts', ext: 'ts' },
			{ relativePath: 'src/b.ts', ext: 'ts' },
		];
		const nodeIdSet = new Set(files.map((f) => f.relativePath));
		const edges = inferEdgesDeterministic(files, [], nodeIdSet);
		assert.deepStrictEqual(edges, []);
	});

	it('detects an ES import between two scanned files', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/a.ts', ext: 'ts' },
			{ relativePath: 'src/b.ts', ext: 'ts' },
		];
		const nodeIdSet = new Set(files.map((f) => f.relativePath));
		const snippets = [
			{ relativePath: 'src/a.ts', content: "import { foo } from './b';" },
		];
		const edges = inferEdgesDeterministic(files, snippets, nodeIdSet);
		assert.strictEqual(edges.length, 1);
		assert.strictEqual(edges[0].from, 'src/a.ts');
		assert.strictEqual(edges[0].to, 'src/b.ts');
		assert.strictEqual(edges[0].relation, 'imports');
	});

	it('detects a CommonJS require between two scanned files', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/main.js', ext: 'js' },
			{ relativePath: 'src/helper.js', ext: 'js' },
		];
		const nodeIdSet = new Set(files.map((f) => f.relativePath));
		const snippets = [
			{ relativePath: 'src/main.js', content: "const h = require('./helper');" },
		];
		const edges = inferEdgesDeterministic(files, snippets, nodeIdSet);
		assert.strictEqual(edges.length, 1);
		assert.strictEqual(edges[0].from, 'src/main.js');
		assert.strictEqual(edges[0].to, 'src/helper.js');
	});

	it('does NOT create edges to files not in the scanned set', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/a.ts', ext: 'ts' },
		];
		const nodeIdSet = new Set(files.map((f) => f.relativePath));
		// Import targets an external package and a file not in the scan result
		const snippets = [
			{
				relativePath: 'src/a.ts',
				content: "import x from 'vscode'; import y from './notInScan';",
			},
		];
		const edges = inferEdgesDeterministic(files, snippets, nodeIdSet);
		assert.deepStrictEqual(edges, []);
	});

	it('does NOT produce self-referential edges', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/a.ts', ext: 'ts' },
		];
		const nodeIdSet = new Set(files.map((f) => f.relativePath));
		// pathological: file appears to import itself
		const snippets = [
			{ relativePath: 'src/a.ts', content: "import './a';" },
		];
		const edges = inferEdgesDeterministic(files, snippets, nodeIdSet);
		assert.deepStrictEqual(edges, []);
	});

	it('handles imports with explicit .ts extension', () => {
		const files: WorkspaceFile[] = [
			{ relativePath: 'src/x.ts', ext: 'ts' },
			{ relativePath: 'src/y.ts', ext: 'ts' },
		];
		const nodeIdSet = new Set(files.map((f) => f.relativePath));
		const snippets = [
			{ relativePath: 'src/x.ts', content: "import { z } from './y.ts';" },
		];
		const edges = inferEdgesDeterministic(files, snippets, nodeIdSet);
		assert.strictEqual(edges.length, 1);
		assert.strictEqual(edges[0].to, 'src/y.ts');
	});
});

// ─── writeGraph / readGraph round-trip with real scanned nodes ────────────────

describe('writeGraph round-trip with scanner-derived nodes', () => {
	async function makeTmpDir(): Promise<string> {
		return fs.mkdtemp(path.join(os.tmpdir(), 'bobgraph-adapter-test-'));
	}

	it('writes and reads back a graph built from scanned files', async () => {
		const tmp = await makeTmpDir();
		try {
			const files: WorkspaceFile[] = [
				{ relativePath: 'src/index.ts', ext: 'ts' },
				{ relativePath: 'src/util.ts', ext: 'ts' },
			];
			const nodes = buildNodesFromScannedFiles(files);
			const edges = [{ from: 'src/index.ts', to: 'src/util.ts', relation: 'imports' }];
			await writeGraph(tmp, { nodes, edges });
			const result = await readGraph(tmp);
			assert.strictEqual(result.nodes.length, 2);
			assert.strictEqual(result.edges.length, 1);
			assert.strictEqual(result.nodes[0].id, 'src/index.ts');
			assert.strictEqual(result.nodes[0].filePath, 'src/index.ts');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('writes a valid graph with no edges when no dependencies exist', async () => {
		const tmp = await makeTmpDir();
		try {
			const files: WorkspaceFile[] = [
				{ relativePath: 'standalone.ts', ext: 'ts' },
			];
			const nodes = buildNodesFromScannedFiles(files);
			await writeGraph(tmp, { nodes, edges: [] });
			const result = await readGraph(tmp);
			assert.strictEqual(result.nodes.length, 1);
			assert.deepStrictEqual(result.edges, []);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('overwrites an existing graph file', async () => {
		const tmp = await makeTmpDir();
		try {
			// Write first version
			const firstFiles: WorkspaceFile[] = [
				{ relativePath: 'old.ts', ext: 'ts' },
			];
			await writeGraph(tmp, { nodes: buildNodesFromScannedFiles(firstFiles), edges: [] });

			// Overwrite with a different graph
			const secondFiles: WorkspaceFile[] = [
				{ relativePath: 'new.ts', ext: 'ts' },
				{ relativePath: 'other.ts', ext: 'ts' },
			];
			await writeGraph(tmp, { nodes: buildNodesFromScannedFiles(secondFiles), edges: [] });

			const result = await readGraph(tmp);
			assert.strictEqual(result.nodes.length, 2);
			assert.ok(result.nodes.some((n) => n.id === 'new.ts'));
			assert.ok(!result.nodes.some((n) => n.id === 'old.ts'));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
