import { cp, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await mkdir(path.join(dist, 'vendor'), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'pdf-engine.js']) {
  await copyFile(path.join(root, 'src', file), path.join(dist, file));
}
await copyFile(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.esm.min.js'), path.join(dist, 'vendor/pdf-lib.js'));
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
  await copyFile(path.join(root, 'node_modules/pdfjs-dist/build', file), path.join(dist, 'vendor', file));
}
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(path.join(root, 'node_modules/pdfjs-dist', dir), path.join(dist, 'vendor', dir), { recursive: true });
}
await copyFile(path.join(root, 'node_modules/pdf-lib/LICENSE.md'), path.join(dist, 'vendor/pdf-lib-LICENSE.md'));
await copyFile(path.join(root, 'node_modules/pdfjs-dist/LICENSE'), path.join(dist, 'vendor/pdfjs-LICENSE'));
console.log(`Built browser app in ${dist}`);
