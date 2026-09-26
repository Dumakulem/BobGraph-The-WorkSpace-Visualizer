import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeGraph } from './graphStore';
import { scanWorkspaceFiles, buildFileListSummary } from './workspaceScanner';
import {
	buildNodesFromScannedFiles,
	inferEdgesDeterministic,
} from './graphBuilder';
import type { WorkspaceFile } from './workspaceScanner';
import type { GraphData, GraphNode, GraphEdge } from './graphStore';
import type { SourceSnippet } from './graphBuilder';

// ─── LM selector ─────────────────────────────────────────────────────────────
//
// We ask VS Code for any available chat model. VS Code routes this through
// whatever LM provider is active in the user's environment — IBM Bob IDE
// registers itself as an LM provider via the standard VS Code Language Model
// API, so no API key, no HTTP call, and no extension ID check is needed.
//
// The selector intentionally has no `vendor` or `family` filters so the call
// works with Bob IDE's model, GitHub Copilot, or any other VS Code LM provider.

async function selectModel(): Promise<vscode.LanguageModelChat> {
	const models = await vscode.lm.selectChatModels();
	if (models.length === 0) {
		throw new BobAdapterError(
			'No language model is available.\n' +
			'Make sure IBM Bob (or another VS Code language model provider) is installed and signed in.',
		);
	}
	// Prefer a model whose family contains "claude" or "gpt" (higher quality),
	// but fall back to whatever is available.
	const preferred = models.find(
		(m) => /claude|gpt|llama|granite/i.test(m.family),
	);
	return preferred ?? models[0];
}

// ─── Graph generation ─────────────────────────────────────────────────────────

/**
 * Asks the active VS Code language model to analyse the workspace files and
 * produce a dependency graph, then validates and writes the result to
 * `.bobgraph/workspace-graph.json`.
 *
 * The scanned file list is the authoritative source for graph nodes. Nodes are
 * built deterministically from the scanner output before the model is called;
 * the model is only used to infer dependency edges between those known nodes.
 * Any edge referencing an unknown node ID is silently dropped.
 *
 * Uses only the VS Code Language Model API — no API key, no HTTP request,
 * no hard dependency on any specific extension ID.
 *
 * @param workspaceRoot  Absolute path to the workspace root folder.
 */
export async function runBobGraphGeneration(workspaceRoot: string): Promise<void> {
	const files = await scanWorkspaceFiles(workspaceRoot);
	if (files.length === 0) {
		throw new BobAdapterError(
			'No source files found in the workspace. ' +
			'Open a folder that contains at least one supported source file.',
		);
	}

	// Build the authoritative node list from the scanner output. This is the
	// single source of truth for node IDs and filePaths — the model never adds
	// or removes nodes.
	const nodes = buildNodesFromScannedFiles(files);
	const nodeIdSet = new Set(nodes.map((n) => n.id));

	// Collect source content for files that support import analysis (JS/TS family
	// and Python). We read a bounded sample so the prompt stays within context.
	const sourceSnippets = await collectSourceSnippets(workspaceRoot, files);

	// Ask the model only for dependency edges between the known node IDs.
	// If no model is available, fall back to deterministic import analysis only.
	let edges: GraphEdge[] = [];
	try {
		edges = await inferEdgesFromModel(nodes, sourceSnippets);
	} catch {
		// Model unavailable or returned unusable output — use deterministic analysis.
		edges = inferEdgesDeterministic(files, sourceSnippets, nodeIdSet);
	}

	// Validate that every edge endpoint refers to a node we actually generated.
	// Drop dangling edges rather than letting them cause validation failures.
	const safeEdges = edges.filter(
		(e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to),
	);

	// Deduplicate edges (same from+to+relation may appear from both paths).
	const seenEdges = new Set<string>();
	const dedupedEdges = safeEdges.filter((e) => {
		const key = `${e.from}→${e.to}→${e.relation}`;
		if (seenEdges.has(key)) {
			return false;
		}
		seenEdges.add(key);
		return true;
	});

	const graph: GraphData = { nodes, edges: dedupedEdges };

	// writeGraph validates the schema before writing — throws GraphValidationError
	// if the data does not match the GraphData contract.
	await writeGraph(workspaceRoot, graph);
}

// ─── Source snippet collection ────────────────────────────────────────────────

/** Maximum characters read from a single file for the edge-inference prompt. */
const MAX_SNIPPET_CHARS = 2000;

/** Extensions we attempt to read for import analysis. */
const IMPORT_ANALYSIS_EXTS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py',
]);

async function collectSourceSnippets(
	workspaceRoot: string,
	files: WorkspaceFile[],
): Promise<SourceSnippet[]> {
	const snippets: SourceSnippet[] = [];
	for (const f of files) {
		if (!IMPORT_ANALYSIS_EXTS.has(f.ext)) {
			continue;
		}
		try {
			const absolute = path.join(workspaceRoot, f.relativePath);
			const raw = await fs.readFile(absolute, 'utf8');
			snippets.push({
				relativePath: f.relativePath,
				content: raw.length > MAX_SNIPPET_CHARS ? raw.slice(0, MAX_SNIPPET_CHARS) : raw,
			});
		} catch {
			// Unreadable file — skip silently.
		}
	}
	return snippets;
}

// ─── Model-based edge inference ───────────────────────────────────────────────

/**
 * Asks the language model to infer dependency edges between the supplied nodes,
 * given source snippets as evidence. Returns only edges whose endpoints exist
 * in nodeIds; dangling edges are dropped by the caller.
 */
async function inferEdgesFromModel(
	nodes: GraphNode[],
	snippets: SourceSnippet[],
): Promise<GraphEdge[]> {
	const model = await selectModel();
	const token = new vscode.CancellationTokenSource().token;

	const prompt = buildEdgePrompt(nodes, snippets);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];

	let rawResponse = '';
	const response = await model.sendRequest(messages, {}, token);
	for await (const chunk of response.text) {
		rawResponse += chunk;
	}

	const jsonText = extractJson(rawResponse);
	if (!jsonText) {
		throw new BobAdapterError(
			'The language model did not return a valid JSON edges array.\n' +
			'Raw response (first 500 chars): ' + rawResponse.slice(0, 500),
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		throw new BobAdapterError(
			`Failed to parse language model response as JSON: ${String(err)}\n` +
			'Raw JSON text (first 500 chars): ' + jsonText.slice(0, 500),
		);
	}

	// Accept either { edges: [...] } or a bare array.
	const rawEdges = Array.isArray(parsed)
		? parsed
		: (isObject(parsed) && Array.isArray(parsed['edges']) ? parsed['edges'] : null);

	if (!rawEdges) {
		throw new BobAdapterError('Model response did not contain a valid edges array.');
	}

	const edges: GraphEdge[] = [];
	for (const e of rawEdges) {
		if (
			isObject(e) &&
			typeof e['from'] === 'string' && e['from'].trim() !== '' &&
			typeof e['to'] === 'string' && e['to'].trim() !== '' &&
			typeof e['relation'] === 'string' && e['relation'].trim() !== ''
		) {
			edges.push({ from: e['from'] as string, to: e['to'] as string, relation: e['relation'] as string });
		}
	}
	return edges;
}

// ─── Node explanation ─────────────────────────────────────────────────────────

/**
 * Asks the active VS Code language model to explain the given file and returns
 * a plain-text summary suitable for display in the BobGraph side panel.
 *
 * @param nodeId    The node's id string from the graph JSON (used only for display).
 * @param filePath  Absolute path to the file to explain.
 */
export async function runBobNodeExplanation(
	nodeId: string,
	filePath: string,
): Promise<string> {
	let fileContent: string;
	try {
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		fileContent = Buffer.from(bytes).toString('utf8');
	} catch {
		return `Could not read file for node "${nodeId}" (${filePath}).`;
	}

	// Truncate very large files — LMs have context limits and we only need a
	// summary, not a full verbatim copy in the prompt.
	const MAX_CHARS = 8000;
	const truncated = fileContent.length > MAX_CHARS
		? fileContent.slice(0, MAX_CHARS) + '\n\n[...file truncated for brevity...]'
		: fileContent;

	const model = await selectModel().catch(() => null);
	if (!model) {
		return (
			`No language model available to explain "${nodeId}".\n` +
			`Ensure IBM Bob (or another VS Code LM provider) is installed and signed in.`
		);
	}

	const token = new vscode.CancellationTokenSource().token;
	const messages = [
		vscode.LanguageModelChatMessage.User(buildExplainPrompt(nodeId, filePath, truncated)),
	];

	let explanation = '';
	try {
		const response = await model.sendRequest(messages, {}, token);
		for await (const chunk of response.text) {
			explanation += chunk;
		}
	} catch (err) {
		return `Language model request failed for "${nodeId}": ${String(err)}`;
	}

	return explanation.trim() || `The language model returned an empty response for "${nodeId}".`;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildEdgePrompt(nodes: GraphNode[], snippets: SourceSnippet[]): string {
	const nodeList = nodes.map((n) => n.id).join('\n');
	const snippetText = snippets
		.map((s) => `--- ${s.relativePath} ---\n${s.content}`)
		.join('\n\n');

	return `You are analysing a workspace dependency graph for BobGraph.

The following node IDs represent the complete set of source files. Do NOT invent additional nodes.

KNOWN NODE IDs (one per line):
${nodeList}

Below are source file excerpts to help you identify imports and dependencies.

SOURCE EXCERPTS:
${snippetText}

Your task: return ONLY a JSON array of dependency edges between the known nodes.
Each edge must have exactly these three fields:
  "from": the node ID of the file that imports or depends on the other
  "to":   the node ID of the file being imported or depended upon
  "relation": a short string describing the relationship, e.g. "imports"

Rules:
1. Only emit edges whose "from" and "to" values are node IDs from the KNOWN NODE IDs list above.
2. Do not invent files or use paths not present in the list.
3. If there are no detected dependencies, return an empty array: []
4. Return ONLY a JSON array. No markdown fences, no prose, no extra fields.

Example output:
[{"from":"src/a.ts","to":"src/b.ts","relation":"imports"}]
`;
}

function buildExplainPrompt(nodeId: string, filePath: string, content: string): string {
	return `You are a senior software engineer explaining code to a new team member.

File: ${filePath}
Node ID: ${nodeId}

Provide a concise plain-text summary (3–6 sentences) of what this file does, its main responsibilities, and how it fits into the overall codebase. Do not use markdown. Do not repeat the file path.

File contents:
${content}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extracts the outermost JSON object or array from a string that may contain
 * surrounding prose or markdown code fences.
 */
function extractJson(text: string): string | null {
	// Strip markdown code fences if present.
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		return fenceMatch[1].trim();
	}

	// Try array first (our edge prompt asks for an array).
	const arrStart = text.indexOf('[');
	const arrEnd = text.lastIndexOf(']');
	if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
		return text.slice(arrStart, arrEnd + 1);
	}

	// Fall back to object.
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) {
		return null;
	}
	return text.slice(start, end + 1);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class BobAdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BobAdapterError';
	}
}

/**
 * Retained for backward compatibility — previously thrown by the stub.
 * @deprecated Use BobAdapterError.
 */
export class BobAdapterNotImplementedError extends BobAdapterError {
	constructor(message: string) {
		super(message);
		this.name = 'BobAdapterNotImplementedError';
	}
}

// Re-export pure functions and types for use in tests and other modules.
export { buildNodesFromScannedFiles, inferEdgesDeterministic, buildFileListSummary };
export type { SourceSnippet };
