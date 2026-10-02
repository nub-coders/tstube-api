import { cpSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'assets');
const dest = join(root, 'dist', 'assets');

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`Copied assets -> ${dest}`);
} else {
  console.warn(`No assets directory at ${src}`);
}

const uploadScriptSrc = join(root, 'scripts', 'upload.sh');
const uploadScriptDest = join(dest, 'upload.sh');
if (existsSync(uploadScriptSrc) && existsSync(dest)) {
  copyFileSync(uploadScriptSrc, uploadScriptDest);
  console.log(`Copied upload.sh -> ${uploadScriptDest}`);
}
