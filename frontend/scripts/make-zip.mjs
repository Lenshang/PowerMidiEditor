// Packages the Vite build into dist/assets.zip which CMake embeds into the
// plugin via juce_add_binary_data (see root CMakeLists.txt).
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const zipPath = path.join(distDir, 'assets.zip');
const indexHtml = path.join(distDir, 'index.html');

if (!fs.existsSync(indexHtml)) {
  console.error('make-zip: dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

const zip = new AdmZip();
for (const name of fs.readdirSync(distDir, { recursive: true })) {
  const rel = String(name).replaceAll('\\', '/');
  const full = path.join(distDir, rel);
  if (!fs.statSync(full).isFile()) continue;
  if (rel === 'assets.zip') continue; // never embed the previous archive
  zip.addFile(rel, fs.readFileSync(full));
}
zip.writeZip(zipPath);
console.log(`make-zip: wrote ${zipPath} (${zip.getEntries().length} entries)`);
