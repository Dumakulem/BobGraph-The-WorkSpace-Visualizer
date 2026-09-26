import * as path from 'node:path';

/**
 * Validated, resolved parameters for opening a file in the editor.
 * Produced by resolveOpenFileRequest; consumed by the extension host.
 */
export type OpenFileRequest = {
    /** Absolute path that is guaranteed to be inside the workspace root. */
    absoluteFilePath: string;
    /** 1-based line number. Always >= 1. */
    line: number;
};

/**
 * Thrown when an openFile message from the webview cannot be fulfilled.
 * The message is user-facing and should be shown via showErrorMessage.
 */
export class OpenFileValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OpenFileValidationError';
    }
}

/**
 * Validates and resolves an openFile message from the webview.
 *
 * Accepts the raw (untrusted) message fields and the current workspace root.
 * Returns a validated OpenFileRequest on success; throws OpenFileValidationError
 * with a user-facing message on any failure.
 *
 * Validation rules (in order):
 *   1. A workspace folder must be open.
 *   2. filePath must be a non-empty string.
 *   3. filePath must not be absolute.
 *   4. filePath must not contain ".." path segments.
 *   5. The resolved path must remain inside the workspace root.
 *   6. line is normalised: non-integer or < 1 defaults to 1.
 *
 * File existence is NOT checked here. The host's openTextDocument call will
 * surface that error naturally.
 *
 * @param filePath      Raw filePath from the webview message.
 * @param rawLine       Raw line from the webview message.
 * @param workspaceRoot Absolute path to the workspace root, or undefined.
 */
export function resolveOpenFileRequest(
    filePath: unknown,
    rawLine: unknown,
    workspaceRoot: string | undefined,
): OpenFileRequest {
    // 1. Workspace must be open.
    if (!workspaceRoot) {
        throw new OpenFileValidationError(
            'Cannot open file: no workspace folder is open.',
        );
    }

    // 2. filePath must be a non-empty string.
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new OpenFileValidationError(
            'Cannot open file: the file path supplied by the webview is empty or missing.',
        );
    }

    // 3. Reject absolute paths — the webview must never supply one.
    if (path.isAbsolute(filePath)) {
        throw new OpenFileValidationError(
            `Cannot open file: the path "${filePath}" is absolute. ` +
            'Only workspace-relative paths are accepted.',
        );
    }

    // 4. Reject obvious traversal sequences before resolving.
    const normalised = path.normalize(filePath);
    if (normalised.startsWith('..')) {
        throw new OpenFileValidationError(
            `Cannot open file: the path "${filePath}" attempts to traverse outside the workspace.`,
        );
    }

    // 5. Resolve and confirm the result stays inside the workspace root.
    const absolute = path.resolve(workspaceRoot, filePath);
    const root = path.normalize(workspaceRoot);
    const resolvedNorm = path.normalize(absolute);
    if (resolvedNorm !== root && !resolvedNorm.startsWith(root + path.sep)) {
        throw new OpenFileValidationError(
            `Cannot open file: "${filePath}" resolves outside the workspace root.`,
        );
    }

    // 6. Normalise line: must be a finite integer >= 1; default to 1.
    const lineNum = typeof rawLine === 'number' && Number.isFinite(rawLine) && rawLine >= 1
        ? Math.floor(rawLine)
        : 1;

    return { absoluteFilePath: absolute, line: lineNum };
}
