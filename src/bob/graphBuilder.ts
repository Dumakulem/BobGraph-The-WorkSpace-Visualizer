import * as path from 'node:path';
import type { GraphEdge, GraphNode } from './graphStore';
import type { WorkspaceFile } from './workspaceScanner';

export type SourceSnippet = {
	relativePath: string;
	content: string;
};

export function buildNodesFromScannedFiles(files: WorkspaceFile[]): GraphNode[] {
	return files.map(file => ({
		id: file.relativePath,
		label: path.posix.basename(file.relativePath),
		type: 'file',
		filePath: file.relativePath,
	}));
}

export function inferEdgesDeterministic(
	files: WorkspaceFile[],
	snippets: SourceSnippet[],
	nodeIds: Set<string>,
): GraphEdge[] {
	const knownPaths = new Set(files.map(file => file.relativePath));
	const edges: GraphEdge[] = [];
	for (const snippet of snippets) {
		const directory = path.posix.dirname(snippet.relativePath);
		for (const target of extractImportTargets(snippet.content)) {
			const resolved = resolveRelativeImport(target, directory, knownPaths);
			if (resolved && nodeIds.has(resolved) && resolved !== snippet.relativePath) {
				edges.push({ from: snippet.relativePath, to: resolved, relation: 'imports' });
			}
		}
	}
	return edges;
}

function extractImportTargets(source: string): string[] {
	const targets: string[] = [];
	for (const match of source.matchAll(/\bimport\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g)) {
		targets.push(match[1]);
	}
	for (const match of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		targets.push(match[1]);
	}
	for (const match of source.matchAll(/^from\s+(\.{1,2}[\w/.]+)\s+import\b/gm)) {
		targets.push(match[1]);
	}
	return targets;
}

function resolveRelativeImport(
	specifier: string,
	fromDirectory: string,
	knownPaths: Set<string>,
): string | undefined {
	if (!specifier.startsWith('.')) {
		return undefined;
	}
	const joined = path.posix.normalize(path.posix.join(fromDirectory, specifier));
	const candidates = [
		joined,
		...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'].map(ext => `${joined}.${ext}`),
		...['ts', 'tsx', 'js', 'jsx'].map(ext => `${joined}/index.${ext}`),
	];
	return candidates.find(candidate => knownPaths.has(candidate));
}
