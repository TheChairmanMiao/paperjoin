import { mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'native/CompressPDF.swift');
const binary = path.join(root, 'native/bin/paperjoin-compress');
const cache = path.join(root, 'artifacts/swift-module-cache');
if (process.platform !== 'darwin') throw new Error('The PDF compression helper requires macOS.');
const sourceInfo = await stat(source);
const buildInfo = await stat(fileURLToPath(import.meta.url));
const outputInfo = await stat(binary).catch(() => null);
if (!outputInfo || outputInfo.mtimeMs < Math.max(sourceInfo.mtimeMs, buildInfo.mtimeMs)) {
  await mkdir(path.dirname(binary), { recursive: true });
  await mkdir(cache, { recursive: true });
  execFileSync('/usr/bin/xcrun', ['swiftc', source, '-O', '-target', 'arm64-apple-macosx13.0', '-module-cache-path', cache, '-framework', 'Quartz', '-framework', 'PDFKit', '-o', binary], { stdio: 'inherit' });
  console.log('Built native Mac PDF compressor.');
} else {
  console.log('Native Mac PDF compressor is up to date.');
}
