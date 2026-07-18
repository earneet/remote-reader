import { mkdirSync } from 'node:fs';
import { mkdir, writeFile as fsWrite, readFile as fsRead } from 'node:fs/promises';
import { dirname } from 'node:path';

export function ensureDir(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true });
}

export async function writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await fsWrite(path, content, 'utf-8');
}

export async function readFile(path: string): Promise<string> {
    return fsRead(path, 'utf-8');
}
