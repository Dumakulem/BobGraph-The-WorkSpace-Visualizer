import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeGraph } from './graphStore';
import { buildNodesFromScannedFiles, inferEdgesDeterministic } from './graphBuilder';
import { scanWorkspaceFiles } from './workspaceScanner';
import type { SourceSnippet } from './graphBuilder';
import type { GraphData, GraphEdge, GraphNode } from './graphStore';

const MAX_SNIPPET_CHARS = 2000;
const MAX_EXPLANATION_CHARS = 8000;
const MAX_AGENT_QUESTION_CHARS = 4000;

export class BobAdapterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BobAdapterError';
	}
}

export class BobAdapterNotImplementedError extends BobAdapterError {}

export async function generateBobGraph(workspaceRoot: string): Promise<GraphData> {
	const files = await scanWorkspaceFiles(workspaceRoot);
	if (files.length === 0) {
		throw new BobAdapterError('No supported source files were found in the workspace.');
	}

	const nodes = buildNodesFromScannedFiles(files);
	const nodeIds = new Set(nodes.map(node => node.id));
	const snippets = await collectSourceSnippets(workspaceRoot, files);
	let edges: GraphEdge[];
	try {
		edges = await inferEdgesFromModel(nodes, snippets);
	} catch {
		edges = inferEdgesDeterministic(files, snippets, nodeIds);
	}

	const seen = new Set<string>();
	const safeEdges = edges.filter(edge => {
		if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
			return false;
		}
		const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
	return { nodes, edges: safeEdges };
}

export async function runBobGraphGeneration(workspaceRoot: string): Promise<void> {
	await writeGraph(workspaceRoot, await generateBobGraph(workspaceRoot));
}

export async function runBobNodeExplanation(nodeId: string, filePath: string): Promise<string> {
	let content: string;
	try {
		content = (await fs.readFile(filePath, 'utf8')).slice(0, MAX_EXPLANATION_CHARS);
	} catch (error) {
		throw new BobAdapterError(`Unable to read "${filePath}" for explanation: ${String(error)}`);
	}

	const model = await selectModel();
	const prompt = `You are a senior software engineer onboarding a teammate.
Explain the file below in 3-6 concise plain-text sentences. Cover its purpose,
main responsibilities, and important dependencies. Do not modify files.
Node: ${nodeId}
File: ${filePath}

File contents:
${content}`;
	return sendTextRequest(model, prompt);
}

export interface BobAgentResponse {
	answer: string;
	modelName: string;
}

type AgentProgress = (modelName: string) => void;

export async function runBobAgentQuestion(
	nodeId: string,
	filePath: string,
	question: string,
	onProgress?: AgentProgress,
): Promise<BobAgentResponse> {
	const trimmedQuestion = question.trim();
	if (!trimmedQuestion) {
		throw new BobAdapterError('Ask the AI assistant a question before sending.');
	}
	if (trimmedQuestion.length > MAX_AGENT_QUESTION_CHARS) {
		throw new BobAdapterError(
			`Questions must be ${MAX_AGENT_QUESTION_CHARS} characters or fewer.`,
		);
	}

	let content: string;
	try {
		content = (await fs.readFile(filePath, 'utf8')).slice(0, MAX_EXPLANATION_CHARS);
	} catch (error) {
		throw new BobAdapterError(`Unable to read "${filePath}" for the AI assistant: ${String(error)}`);
	}

	const model = await selectModel();
	const modelName = model.name || model.family || 'Language Model';
	onProgress?.(modelName);
	const prompt = `You are an AI software engineering assistant helping a developer understand a codebase.
Answer the user's question about the selected node using the source context below.
Be concise and practical. Do not modify files or claim to have run code.
Node: ${nodeId}
File: ${filePath}

User question:
${trimmedQuestion}

Source context:
${content}`;
	return {
		answer: await sendTextRequest(model, prompt),
		modelName,
	};
}

export async function checkLanguageModelConnection(): Promise<string> {
	const models = await selectAvailableModels();
	if (models.length === 0) {
		throw new BobAdapterError(
			'No language model is available. Sign in to GitHub Copilot and allow this extension to use language models, or install another provider that exposes the VS Code Language Model API.',
		);
	}
	return models.map(model => `${model.name} (${model.vendor}/${model.family})`).join(', ');
}

async function inferEdgesFromModel(nodes: GraphNode[], snippets: SourceSnippet[]): Promise<GraphEdge[]> {
	const model = await selectModel();
	const prompt = `Analyze dependencies for BobGraph.
Return ONLY a JSON array. Each item must contain exactly "from", "to", and "relation".
Only use IDs from this list; do not invent files:
${nodes.map(node => node.id).join('\n')}

Source excerpts:
${snippets.map(snippet => `--- ${snippet.relativePath} ---\n${snippet.content}`).join('\n\n')}

Example: [{"from":"src/a.ts","to":"src/b.ts","relation":"imports"}]
Return [] when no dependency is known.`;
	const raw = await sendTextRequest(model, prompt);
	const json = extractJson(raw);
	if (!json) {
		throw new BobAdapterError('Language model did not return a JSON edge array.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new BobAdapterError('Language model returned invalid JSON.');
	}
	const values = Array.isArray(parsed)
		? parsed
		: isObject(parsed) && Array.isArray(parsed.edges) ? parsed.edges : [];
	return values.flatMap(value => {
		if (!isObject(value) ||
			typeof value.from !== 'string' ||
			typeof value.to !== 'string' ||
			typeof value.relation !== 'string') {
			return [];
		}
		return [{ from: value.from, to: value.to, relation: value.relation }];
	});
}

async function collectSourceSnippets(
	workspaceRoot: string,
	files: Awaited<ReturnType<typeof scanWorkspaceFiles>>,
): Promise<SourceSnippet[]> {
	const supported = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py']);
	const snippets: SourceSnippet[] = [];
	for (const file of files) {
		if (!supported.has(file.ext)) {
			continue;
		}
		try {
			const content = await fs.readFile(path.join(workspaceRoot, file.relativePath), 'utf8');
			snippets.push({
				relativePath: file.relativePath,
				content: content.slice(0, MAX_SNIPPET_CHARS),
			});
		} catch {
			// An unreadable file remains a node; it simply contributes no evidence.
		}
	}
	return snippets;
}

async function selectModel(): Promise<vscode.LanguageModelChat> {
	const models = await selectAvailableModels();
	if (models.length === 0) {
		throw new BobAdapterError(
			'No language model is available. Sign in to GitHub Copilot and allow this extension to use language models, or install another compatible provider.',
		);
	}
	return models.find(model => /claude|gpt|llama|granite/i.test(model.family)) ?? models[0];
}

async function selectAvailableModels(): Promise<vscode.LanguageModelChat[]> {
	if (availableModels && availableModels.length > 0) {
		return availableModels;
	}
	// Query all registered providers so IBM Bob models are not excluded by a
	// Copilot-specific vendor filter.
	const allModels = await vscode.lm.selectChatModels();
	// A provider may still be starting when the first request is made. Do not
	// cache an empty result; the next user action should retry discovery.
	if (allModels.length > 0) {
		availableModels = allModels;
	}
	return allModels;
}

let availableModels: vscode.LanguageModelChat[] | undefined;
if (vscode.lm?.onDidChangeChatModels) {
	vscode.lm.onDidChangeChatModels(() => {
		availableModels = undefined;
	});
}

async function sendTextRequest(model: vscode.LanguageModelChat, prompt: string): Promise<string> {
	const cancellation = new vscode.CancellationTokenSource();
	try {
	const response = await model.sendRequest(
		[vscode.LanguageModelChatMessage.User(prompt)],
		{},
		cancellation.token,
	);
	let text = '';
	for await (const chunk of response.text) {
		text += chunk;
	}
	if (!text.trim()) {
		throw new BobAdapterError('Language model returned an empty response.');
	}
	return text.trim();
	} finally {
		cancellation.dispose();
	}
}

function extractJson(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		return fenced[1].trim();
	}
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
