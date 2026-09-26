import * as path from 'node:path';
import { runBobNodeExplanation } from './bobAdapter';
import { GraphValidationError } from './graphStore';

/**
 * Returns a Bob-generated explanation for the given node.
 *
 * @param nodeId       The node's id string from the graph JSON.
 * @param filePath     The node's filePath from the graph, resolved to an
 *                     absolute path by the caller.
 */
export async function explainNode(nodeId: string, filePath: string): Promise<string> {
	return runBobNodeExplanation(nodeId, filePath);
}

/**
 * Resolves a node's relative filePath to an absolute path and verifies the
 * result stays inside the workspace root.
 *
 * Throws GraphValidationError if the resolved path escapes the workspace root.
 * This is a defence-in-depth check: validateGraph already rejects absolute
 * paths and leading '..' segments, but path.resolve can still produce a path
 * outside the root through edge cases (e.g. on Windows with drive letters).
 *
 * @param workspaceRoot     Absolute path to the workspace root.
 * @param relativeFilePath  The filePath value from a GraphNode (relative to root).
 */
export function resolveNodeFilePath(workspaceRoot: string, relativeFilePath: string): string {
	const resolved = path.resolve(workspaceRoot, relativeFilePath);
	// Normalise both sides to ensure the prefix check is reliable on all OSes.
	const root = path.normalize(workspaceRoot);
	const normalised = path.normalize(resolved);
	// Allow exact match (file at root itself) or child paths (must be followed
	// by the platform path separator to avoid false prefix matches).
	if (normalised !== root && !normalised.startsWith(root + path.sep)) {
		throw new GraphValidationError(
			`Node filePath "${relativeFilePath}" resolves outside the workspace root.`,
		);
	}
	return resolved;
}
