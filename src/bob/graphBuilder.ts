import * as path from 'node:path';
import type { WorkspaceFile } from './workspaceScanner';
import type { GraphNode, GraphEdge } from './graphStore';

// ─── Node construction ────────────────────────────────────────────────────────

/**
 * Builds a GraphNode for every file returned by the scanner.
 * IDs and filePaths are normalized workspace-relative paths (forward slashes).
 */
export function buildNodesFromScannedFiles(files: WorkspaceFile[]): GraphNode[] {
	return files.map((f) => ({
		id: f.relativePath,
		label: path.basename(f.relativePath),
		type: 'file',
		filePath: f.relativePath,
	}));
}

// ─── Deterministic edge inference ────────────────────────────────────────────

export type SourceSnippet = { relativePath: string; content: string };

/**
 * Derives import edges from static analysis of import/require statements.
 * Only emits edges whose `to` endpoint resolves to a known scanned file.
 */
export function inferEdgesDeterministic(
	files: WorkspaceFile[],
	snippets: SourceSnippet[],
	nodeIdSet: Set<string>,
): GraphEdge[] {
	const knownPaths = new Set(files.map((f) => f.relativePath));
	const edges: GraphEdge[] = [];

	for (const snippet of snippets) {
		const dir = path.posix.dirname(snippet.relativePath);
		const importTargets = extractImportTargets(snippet.content);
		for (const target of importTargets) {
			const resolved = resolveRelativeImport(target, dir, knownPaths);
			if (resolved && nodeIdSet.has(resolved) && resolved !== snippet.relativePath) {
				edges.push({ from: snippet.relativePath, to: resolved, relation: 'imports' });
			}
		}
	}
	return edges;
}

/** Extracts bare specifier strings from import/require statements. */
function extractImportTargets(source: string): string[] {
	const targets: string[] = [];
	// ES import: import ... from './foo'  or  import './foo'
	for (const m of source.matchAll(/\bimport\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g)) {
		targets.push(m[1]);
	}
	// CommonJS require: require('./foo')
	for (const m of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		targets.push(m[1]);
	}
	// Python: from .module import something — must be followed by \s+import\s
	// Use a distinct pattern that won't overlap with JS `from '...'` syntax.
	for (const m of source.matchAll(/^from\s+(\.{1,2}[\w/.]+)\s+import\b/gm)) {
		targets.push(m[1]);
	}
	return targets;
}

/** Tries to resolve a relative import specifier to a known scanned file path. */
export function resolveRelativeImport(
	specifier: string,
	fromDir: string,
	knownPaths: Set<string>,
): string | null {
	if (!specifier.startsWith('.')) {
		return null;
	}
	const candidates: string[] = [];
	const joined = path.posix.normalize(path.posix.join(fromDir, specifier));
	candidates.push(joined);
	for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py']) {
		candidates.push(`${joined}.${ext}`);
	}
	for (const ext of ['ts', 'tsx', 'js', 'jsx']) {
		candidates.push(`${joined}/index.${ext}`);
	}
	for (const candidate of candidates) {
		if (knownPaths.has(candidate)) {
			return candidate;
		}
	}
	return null;
}
