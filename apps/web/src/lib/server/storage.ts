import { mkdir, writeFile as fsWrite, readFile as fsRead } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await fsWrite(path, content, 'utf-8');
}

export async function readFile(path: string): Promise<string> {
    return fsRead(path, 'utf-8');
}
