import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * A lightweight description of a single workspace file, suitable for
 * inclusion in an LM prompt without loading file contents.
 */
export type WorkspaceFile = {
	/** Path relative to the workspace root, using forward slashes. */
	relativePath: string;
	/** File extension without the leading dot, e.g. "ts", "json", "md". */
	ext: string;
};

/** Extensions treated as source / documentation — everything else is skipped. */
const INCLUDED_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
	'py', 'java', 'cs', 'cpp', 'c', 'h', 'hpp',
	'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala',
	'html', 'css', 'scss', 'less',
	'json', 'yaml', 'yml', 'toml', 'xml',
	'md', 'txt', 'sh', 'bash', 'zsh',
	'sql', 'graphql', 'proto',
]);

/** Directory names always skipped, regardless of depth. */
const IGNORED_DIRS = new Set([
	'node_modules', '.git', '.bobgraph', 'dist', 'out', 'build',
	'.vscode', '.idea', '__pycache__', '.mypy_cache',
	'coverage', '.next', '.nuxt', 'vendor', 'target',
]);

/** Hard cap — prevents enormous repos from producing prompts that exceed context. */
const MAX_FILES = 300;

/**
 * Recursively walks the workspace root and returns a flat list of source files,
 * skipping build artefacts and ignored directories.
 *
 * The list is capped at MAX_FILES entries; the cap is applied depth-first so
 * top-level directories are always represented.
 *
 * @param workspaceRoot  Absolute path to the workspace root.
 */
export async function scanWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceFile[]> {
	const results: WorkspaceFile[] = [];
	await walk(workspaceRoot, workspaceRoot, results);
	return results;
}

async function walk(
	root: string,
	dir: string,
	results: WorkspaceFile[],
): Promise<void> {
	if (results.length >= MAX_FILES) {
		return;
	}

	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		// Unreadable directory — skip silently.
		return;
	}

	// Sort so the output is deterministic across platforms.
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		if (results.length >= MAX_FILES) {
			break;
		}

		if (entry.isDirectory()) {
			if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
				continue;
			}
			await walk(root, path.join(dir, entry.name), results);
		} else if (entry.isFile()) {
			const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
			if (!INCLUDED_EXTENSIONS.has(ext)) {
				continue;
			}
			const absolute = path.join(dir, entry.name);
			const relativePath = path.relative(root, absolute).replace(/\\/g, '/');
			results.push({ relativePath, ext });
		}
	}
}

/**
 * Builds a compact, newline-separated file list string suitable for inclusion
 * in an LM prompt. Each line is the relative path of one file.
 *
 * @param files  The output of scanWorkspaceFiles.
 */
export function buildFileListSummary(files: WorkspaceFile[]): string {
	return files.map((f) => f.relativePath).join('\n');
}
