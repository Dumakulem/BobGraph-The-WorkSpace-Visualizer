import * as fs from 'fs';
import * as path from 'path';

/** Absolute path to the extension root, resolved from the compiled location in out/test. */
export const ROOT = path.join(__dirname, '..', '..');
export const MEDIA = path.join(ROOT, 'media');

export function readRoot(...segments: string[]): string {
    return fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
}

export function readMedia(...segments: string[]): string {
    return fs.readFileSync(path.join(MEDIA, ...segments), 'utf8');
}

export function readJson<T = any>(...segments: string[]): T {
    return JSON.parse(readRoot(...segments)) as T;
}

export function exists(...segments: string[]): boolean {
    return fs.existsSync(path.join(ROOT, ...segments));
}
