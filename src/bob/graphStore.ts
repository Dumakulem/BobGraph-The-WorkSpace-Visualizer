import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export type GraphNode = {
	id: string;
	label: string;
	type: string;
	filePath: string;
};

export type GraphEdge = {
	from: string;
	to: string;
	relation: string;
};

export type GraphData = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};

export const GRAPH_DIR = '.bobgraph';
export const GRAPH_FILE = 'workspace-graph.json';

export class GraphValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GraphValidationError';
	}
}

export class GraphFileNotFoundError extends Error {
	constructor(filePath: string) {
		super(
			`Graph file not found: ${filePath}\n` +
			`Run "BobGraph: Generate Workspace Graph" to create it.`,
		);
		this.name = 'GraphFileNotFoundError';
	}
}

/**
 * Returns the absolute path to the graph JSON file for the given workspace root.
 */
export function graphFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, GRAPH_DIR, GRAPH_FILE);
}

/**
 * Ensures the .bobgraph directory exists without touching any existing file.
 */
export async function ensureGraphDir(workspaceRoot: string): Promise<void> {
	const dir = path.join(workspaceRoot, GRAPH_DIR);
	await fs.mkdir(dir, { recursive: true });
}

/**
 * Reads and validates .bobgraph/workspace-graph.json from the workspace root.
 * Throws GraphFileNotFoundError if the file is absent.
 * Throws GraphValidationError if the JSON is malformed or fails schema validation.
 * Never returns a silent success for invalid data.
 */
export async function readGraph(workspaceRoot: string): Promise<GraphData> {
	const filePath = graphFilePath(workspaceRoot);

	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf8');
	} catch (err: unknown) {
		if (isNodeError(err) && err.code === 'ENOENT') {
			throw new GraphFileNotFoundError(filePath);
		}
		throw err;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new GraphValidationError(
			`${GRAPH_DIR}/${GRAPH_FILE} contains invalid JSON. Fix or regenerate the file.`,
		);
	}

	return validateGraph(parsed);
}

/**
 * Validates and writes graph data to .bobgraph/workspace-graph.json, creating
 * the directory if needed. Only called by the Bob generation adapter — never
 * called by the read/render path.
 *
 * Validation runs before the file is written so that a Bob-generated payload
 * that fails the schema never reaches disk.
 */
export async function writeGraph(workspaceRoot: string, graph: unknown): Promise<void> {
	// Validate before touching the filesystem — throws GraphValidationError on
	// any schema violation so a bad Bob response never corrupts the stored file.
	validateGraph(graph);
	await ensureGraphDir(workspaceRoot);
	const filePath = graphFilePath(workspaceRoot);
	await fs.writeFile(filePath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
}

// ─── Schema validation ────────────────────────────────────────────────────────

/**
 * Validates the parsed JSON value against the GraphData schema.
 * Returns a typed GraphData on success; throws GraphValidationError on failure.
 */
export function validateGraph(value: unknown): GraphData {
	if (!isObject(value)) {
		throw new GraphValidationError('Graph JSON must be an object with "nodes" and "edges" arrays.');
	}

	if (!Array.isArray(value['nodes'])) {
		throw new GraphValidationError('Graph JSON must have a "nodes" array.');
	}
	if (!Array.isArray(value['edges'])) {
		throw new GraphValidationError('Graph JSON must have an "edges" array.');
	}

	const nodes = value['nodes'] as unknown[];
	const edges = value['edges'] as unknown[];

	const validatedNodes: GraphNode[] = nodes.map((n, i) => validateNode(n, i));

	// Build a set of IDs to check edge references and duplicates
	const nodeIds = new Set<string>();
	for (const node of validatedNodes) {
		if (nodeIds.has(node.id)) {
			throw new GraphValidationError(`Duplicate node id: "${node.id}".`);
		}
		nodeIds.add(node.id);
	}

	const validatedEdges: GraphEdge[] = edges.map((e, i) => validateEdge(e, i, nodeIds));

	return { nodes: validatedNodes, edges: validatedEdges };
}

function validateNode(value: unknown, index: number): GraphNode {
	const prefix = `nodes[${index}]`;
	if (!isObject(value)) {
		throw new GraphValidationError(`${prefix} must be an object.`);
	}

	const id = value['id'];
	const label = value['label'];
	const type = value['type'];
	const filePath = value['filePath'];

	if (typeof id !== 'string' || id.trim() === '') {
		throw new GraphValidationError(`${prefix}.id must be a non-empty string.`);
	}
	if (typeof label !== 'string' || label.trim() === '') {
		throw new GraphValidationError(`${prefix}.label must be a non-empty string.`);
	}
	if (typeof type !== 'string' || type.trim() === '') {
		throw new GraphValidationError(`${prefix}.type must be a non-empty string.`);
	}
	if (typeof filePath !== 'string' || filePath.trim() === '') {
		throw new GraphValidationError(`${prefix}.filePath must be a non-empty string.`);
	}
	// Reject absolute paths and obvious traversal sequences so that a crafted
	// JSON file cannot escape the workspace root when the path is later resolved.
	if (path.isAbsolute(filePath)) {
		throw new GraphValidationError(
			`${prefix}.filePath must be a relative path, got: "${filePath}".`,
		);
	}
	if (path.normalize(filePath).startsWith('..')) {
		throw new GraphValidationError(
			`${prefix}.filePath must not traverse outside the workspace: "${filePath}".`,
		);
	}

	return { id, label, type, filePath };
}

function validateEdge(value: unknown, index: number, nodeIds: Set<string>): GraphEdge {
	const prefix = `edges[${index}]`;
	if (!isObject(value)) {
		throw new GraphValidationError(`${prefix} must be an object.`);
	}

	const from = value['from'];
	const to = value['to'];
	const relation = value['relation'];

	if (typeof from !== 'string' || from.trim() === '') {
		throw new GraphValidationError(`${prefix}.from must be a non-empty string.`);
	}
	if (typeof to !== 'string' || to.trim() === '') {
		throw new GraphValidationError(`${prefix}.to must be a non-empty string.`);
	}
	if (typeof relation !== 'string' || relation.trim() === '') {
		throw new GraphValidationError(`${prefix}.relation must be a non-empty string.`);
	}
	if (!nodeIds.has(from)) {
		throw new GraphValidationError(`${prefix}.from references unknown node id "${from}".`);
	}
	if (!nodeIds.has(to)) {
		throw new GraphValidationError(`${prefix}.to references unknown node id "${to}".`);
	}

	return { from, to, relation };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
	return isObject(err) && 'code' in err;
}
