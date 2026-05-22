import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

await mkdir(dist, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  await copyFile(path.join(src, file), path.join(dist, file));
}
