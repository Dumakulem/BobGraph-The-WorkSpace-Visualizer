import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type WorkspaceFile = {
	relativePath: string;
	ext: string;
};

const INCLUDED_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'cs', 'cpp', 'c', 'h',
	'hpp', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'html', 'css',
	'scss', 'less', 'json', 'yaml', 'yml', 'toml', 'xml', 'md', 'txt', 'sh',
	'bash', 'zsh', 'sql', 'graphql', 'proto',
]);

const IGNORED_DIRS = new Set([
	'node_modules', '.git', '.bobgraph', 'dist', 'out', 'build', '.vscode',
	'.idea', '__pycache__', '.mypy_cache', 'coverage', '.next', '.nuxt',
	'vendor', 'target',
]);

const MAX_FILES = 300;

export async function scanWorkspaceFiles(workspaceRoot: string): Promise<WorkspaceFile[]> {
	const files: WorkspaceFile[] = [];
	await walk(workspaceRoot, workspaceRoot, files);
	return files;
}

async function walk(root: string, directory: string, files: WorkspaceFile[]): Promise<void> {
	if (files.length >= MAX_FILES) {
		return;
	}
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (files.length >= MAX_FILES) {
			return;
		}
		if (entry.isDirectory()) {
			if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
				await walk(root, path.join(directory, entry.name), files);
			}
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const ext = path.extname(entry.name).slice(1).toLowerCase();
		if (INCLUDED_EXTENSIONS.has(ext)) {
			const absolute = path.join(directory, entry.name);
			files.push({
				relativePath: path.relative(root, absolute).replace(/\\/g, '/'),
				ext,
			});
		}
	}
}
