import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	validateGraph,
	readGraph,
	writeGraph,
	GraphValidationError,
	GraphFileNotFoundError,
} from '../bob/graphStore';
import type { GraphData } from '../bob/graphStore';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'bobgraph-test-'));
}

const VALID_GRAPH: GraphData = {
	nodes: [
		{ id: 'a', label: 'Alpha', type: 'file', filePath: 'src/alpha.ts' },
		{ id: 'b', label: 'Beta', type: 'file', filePath: 'src/beta.ts' },
	],
	edges: [
		{ from: 'a', to: 'b', relation: 'imports' },
	],
};

// ─── validateGraph — valid inputs ────────────────────────────────────────────

suite('validateGraph — valid inputs', () => {
	test('accepts a well-formed graph', () => {
		const result = validateGraph(VALID_GRAPH);
		assert.strictEqual(result.nodes.length, 2);
		assert.strictEqual(result.edges.length, 1);
	});

	test('accepts an empty graph', () => {
		const result = validateGraph({ nodes: [], edges: [] });
		assert.strictEqual(result.nodes.length, 0);
		assert.strictEqual(result.edges.length, 0);
	});

	test('accepts a graph with no edges', () => {
		const result = validateGraph({
			nodes: [{ id: 'x', label: 'X', type: 'file', filePath: 'x.ts' }],
			edges: [],
		});
		assert.strictEqual(result.nodes.length, 1);
		assert.strictEqual(result.edges.length, 0);
	});
});

// ─── validateGraph — missing required fields ─────────────────────────────────

suite('validateGraph — missing required fields', () => {
	test('throws when top-level value is not an object', () => {
		assert.throws(
			() => validateGraph([]),
			GraphValidationError,
		);
	});

	test('throws when nodes array is missing', () => {
		assert.throws(
			() => validateGraph({ edges: [] }),
			GraphValidationError,
		);
	});

	test('throws when edges array is missing', () => {
		assert.throws(
			() => validateGraph({ nodes: [] }),
			GraphValidationError,
		);
	});

	test('throws when a node is missing id', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [],
			}),
			GraphValidationError,
		);
	});

	test('throws when a node has empty id', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: '', label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [],
			}),
			GraphValidationError,
		);
	});

	test('throws when a node is missing label', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: 'a', type: 'file', filePath: 'a.ts' }],
				edges: [],
			}),
			GraphValidationError,
		);
	});

	test('throws when a node is missing type', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: 'a', label: 'A', filePath: 'a.ts' }],
				edges: [],
			}),
			GraphValidationError,
		);
	});

	test('throws when a node is missing filePath', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: 'a', label: 'A', type: 'file' }],
				edges: [],
			}),
			GraphValidationError,
		);
	});

	test('throws when an edge is missing from', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: 'a', label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [{ to: 'a', relation: 'imports' }],
			}),
			GraphValidationError,
		);
	});

	test('throws when an edge is missing to', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: 'a', label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [{ from: 'a', relation: 'imports' }],
			}),
			GraphValidationError,
		);
	});

	test('throws when an edge is missing relation', () => {
		assert.throws(
			() => validateGraph({
				nodes: [{ id: 'a', label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [{ from: 'a', to: 'a' }],
			}),
			GraphValidationError,
		);
	});
});

// ─── validateGraph — duplicate node IDs ──────────────────────────────────────

suite('validateGraph — duplicate node IDs', () => {
	test('throws on duplicate node id', () => {
		let caught: unknown;
		try {
			validateGraph({
				nodes: [
					{ id: 'a', label: 'A', type: 'file', filePath: 'a.ts' },
					{ id: 'a', label: 'A2', type: 'file', filePath: 'a2.ts' },
				],
				edges: [],
			});
		} catch (e) {
			caught = e;
		}
		assert.ok(caught instanceof GraphValidationError);
		assert.ok(caught.message.includes('"a"'));
	});
});

// ─── validateGraph — edges referencing missing node IDs ──────────────────────

suite('validateGraph — edges referencing missing nodes', () => {
	test('throws when edge.from references unknown node', () => {
		let caught: unknown;
		try {
			validateGraph({
				nodes: [{ id: 'a', label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [{ from: 'missing', to: 'a', relation: 'imports' }],
			});
		} catch (e) {
			caught = e;
		}
		assert.ok(caught instanceof GraphValidationError);
		assert.ok(caught.message.includes('"missing"'));
	});

	test('throws when edge.to references unknown node', () => {
		let caught: unknown;
		try {
			validateGraph({
				nodes: [{ id: 'a', label: 'A', type: 'file', filePath: 'a.ts' }],
				edges: [{ from: 'a', to: 'missing', relation: 'imports' }],
			});
		} catch (e) {
			caught = e;
		}
		assert.ok(caught instanceof GraphValidationError);
		assert.ok(caught.message.includes('"missing"'));
	});
});

// ─── readGraph — file system integration ─────────────────────────────────────

suite('readGraph — file system integration', () => {
	test('reads and returns a valid graph file', async () => {
		const tmp = await makeTmpDir();
		try {
			await writeGraph(tmp, VALID_GRAPH);
			const result = await readGraph(tmp);
			assert.strictEqual(result.nodes.length, 2);
			assert.strictEqual(result.edges.length, 1);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test('throws GraphFileNotFoundError when the file is missing', async () => {
		const tmp = await makeTmpDir();
		try {
			await assert.rejects(
				() => readGraph(tmp),
				GraphFileNotFoundError,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test('throws GraphValidationError for malformed JSON', async () => {
		const tmp = await makeTmpDir();
		try {
			await fs.mkdir(path.join(tmp, '.bobgraph'), { recursive: true });
			await fs.writeFile(
				path.join(tmp, '.bobgraph', 'workspace-graph.json'),
				'{ not valid json',
				'utf8',
			);
			await assert.rejects(
				() => readGraph(tmp),
				GraphValidationError,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test('throws GraphValidationError for valid JSON that fails schema', async () => {
		const tmp = await makeTmpDir();
		try {
			await fs.mkdir(path.join(tmp, '.bobgraph'), { recursive: true });
			await fs.writeFile(
				path.join(tmp, '.bobgraph', 'workspace-graph.json'),
				JSON.stringify({ nodes: 'wrong' }),
				'utf8',
			);
			await assert.rejects(
				() => readGraph(tmp),
				GraphValidationError,
			);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
