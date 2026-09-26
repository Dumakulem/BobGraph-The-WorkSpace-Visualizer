/**
 * Bob generation adapter — integration boundary
 *
 * This module is the single point of contact between BobGraph and the IBM Bob
 * agent. Both functions below are intentional stubs.
 *
 * ─── What is needed to implement these ────────────────────────────────────────
 *
 * 1. Bob graph generation
 *    - How is the Bob agent exposed to a third-party VS Code extension?
 *      Options include: `vscode.extensions.getExtension('ibm.bob')`, an
 *      injected workspace service, a shared npm package, or a local IPC socket.
 *    - What is the call signature for "analyse this workspace and produce a
 *      dependency graph"? (function name, parameters, return type)
 *    - Is there an authentication or session-token requirement?
 *    - What workspace-size or rate-limit constraints apply?
 *    - Should the result be written by Bob directly, or returned as data?
 *
 * 2. Bob node explanation
 *    - What identifier does Bob accept to describe a node?
 *      (file path, symbol URI, LSP text-document position, arbitrary string ID)
 *    - Does Bob stream the explanation or return it as a single string?
 *    - Is the result plain text, Markdown, or structured JSON?
 *
 * ─── Do not add implementation details here ───────────────────────────────────
 * Do not invent an API endpoint, SDK import, authentication token, or function
 * signature until the above questions are answered from verified IBM Bob IDE
 * documentation or source.
 * ─────────────────────────────────────────────────────────────────────────────
 */


/**
 * Asks the Bob agent to analyse the workspace and write
 * .bobgraph/workspace-graph.json.
 *
 * TODO: Replace the body of this function with the real Bob integration once
 *       the API contract is confirmed.
 *
 * @param workspaceRoot  Absolute path to the workspace root folder.
 */
export async function runBobGraphGeneration(workspaceRoot: string): Promise<void> {
	// ── TODO: call the real Bob agent here ────────────────────────────────────
	// Example shape (do not use — illustrative only):
	//
	//   const bob = vscode.extensions.getExtension('ibm.bob')?.exports;
	//   if (!bob) { throw new Error('IBM Bob extension is not available.'); }
	//   const rawData: unknown = await bob.analyzeWorkspace(workspaceRoot);
	//   // writeGraph validates the schema before writing — throws on bad data.
	//   await writeGraph(workspaceRoot, rawData);
	// ──────────────────────────────────────────────────────────────────────────

	throw new BobAdapterNotImplementedError(
		'Bob graph generation is not yet connected.\n' +
		'See src/bob/bobAdapter.ts for the integration requirements.',
	);
}

/**
 * Asks the Bob agent to explain a node and returns the explanation text.
 *
 * TODO: Replace the body of this function with the real Bob integration once
 *       the API contract is confirmed.
 *
 * @param nodeId      The node's id string from the graph JSON.
 * @param filePath    The node's filePath, resolved to an absolute path.
 */
export async function runBobNodeExplanation(
	nodeId: string,
	filePath: string,
): Promise<string> {
	// ── TODO: call the real Bob agent here ────────────────────────────────────
	// Example shape (do not use — illustrative only):
	//
	//   const bob = vscode.extensions.getExtension('ibm.bob')?.exports;
	//   if (!bob) { throw new Error('IBM Bob extension is not available.'); }
	//   return await bob.explainFile(filePath);
	// ──────────────────────────────────────────────────────────────────────────

	// Graceful placeholder — visible to the user so they know the feature is
	// pending, but does not throw so the rest of the panel keeps working.
	return (
		`Bob explanation for "${nodeId}" is not yet available.\n` +
		`Connect the IBM Bob agent in src/bob/bobAdapter.ts to enable this feature.`
	);
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class BobAdapterNotImplementedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BobAdapterNotImplementedError';
	}
}
