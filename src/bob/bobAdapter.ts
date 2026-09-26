import * as vscode from 'vscode';
import { writeGraph } from './graphStore';
import { scanWorkspaceFiles } from './workspaceScanner';

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

	const model = await selectModel();
	const token = new vscode.CancellationTokenSource().token;

	const prompt = buildGraphPrompt(workspaceRoot);
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];

	let rawResponse = '';
	const response = await model.sendRequest(messages, {}, token);
	for await (const chunk of response.text) {
		rawResponse += chunk;
	}

	// Extract the JSON object from the response. The LM may wrap it in a
	// markdown code fence or add prose — strip everything outside the braces.
	const jsonText = extractJson(rawResponse);
	if (!jsonText) {
		throw new BobAdapterError(
			'The language model did not return a valid JSON graph.\n' +
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

	// writeGraph validates the schema before writing — throws GraphValidationError
	// if the parsed data does not match the GraphData contract.
	await writeGraph(workspaceRoot, parsed);
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

function buildGraphPrompt(workspacePath: string): string {
	return `You are generating structured workspace data for BobGraph.

Analyze the workspace at:
${workspacePath}

Build a dependency graph of the source files.

Return ONLY valid JSON. Do not include Markdown fences, explanations, comments, or additional text.

The JSON must match this exact schema:

{
  "nodes": [
    {
      "id": "string",
      "label": "string",
      "type": "string",
      "filePath": "string"
    }
  ],
  "edges": [
    {
      "from": "string",
      "to": "string",
      "relation": "string"
    }
  ]
}

Rules:

1. Create one node for each relevant source file.
2. "id" must be unique and should normally be the normalized relative file path.
3. "label" should be the file name shown in the graph.
4. "type" should normally be "file".
5. "filePath" must be a relative path from the workspace root.
6. Do not use absolute paths.
7. Do not use paths containing "..".
8. Create an edge when one file imports, requires, references, or depends on another.
9. Every edge "from" and "to" value must match an existing node "id".
10. Do not invent files that do not exist.
11. If there are no relationships, return an empty "edges" array.
12. Return the complete graph, not a summary.
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
 * Extracts the outermost JSON object from a string that may contain surrounding
 * prose or markdown code fences.
 */
function extractJson(text: string): string | null {
	// Strip markdown code fences if present.
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		return fenceMatch[1].trim();
	}

	// Find the first '{' and the matching last '}' in the raw text.
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) {
		return null;
	}
	return text.slice(start, end + 1);
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
