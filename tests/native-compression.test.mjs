import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.join(root, 'native/bin/paperjoin-compress');
const macOnly = { skip: process.platform !== 'darwin' };
let directory;
let imageInput;

before(async () => {
  if (process.platform !== 'darwin') return;
  execFileSync(process.execPath, [path.join(root, 'scripts/build-native.mjs')], { cwd: root, stdio: 'pipe' });
  await mkdir(path.join(root, 'artifacts/compression-tests'), { recursive: true });
  directory = await mkdtemp(path.join(root, 'artifacts/compression-tests/run-'));
  const canvas = createCanvas(3600, 2400);
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(canvas.width, canvas.height);
  let state = 123456;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const noise = (state >>> 27) - 16;
      const index = (y * canvas.width + x) * 4;
      pixels.data[index] = Math.max(0, Math.min(255, 70 + x / 30 + noise));
      pixels.data[index + 1] = Math.max(0, Math.min(255, 90 + y / 25 + noise));
      pixels.data[index + 2] = Math.max(0, Math.min(255, 180 + Math.sin(x / 180) * 35 + noise));
      pixels.data[index + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const image = await document.embedPng(await canvas.encode('png'));
  for (const [index, size] of [[0, [612, 792]], [1, [792, 612]]]) {
    const page = document.addPage(size);
    page.drawText(`Paperjoin searchable vector text ${index + 1}`, { x: 30, y: 550, size: 18, font });
    page.drawRectangle({ x: 30, y: 510, width: 200, height: 12, color: rgb(0.3, 0.2, 0.7) });
    page.drawImage(image, { x: 18, y: 70, width: 576, height: 384 });
    if (index === 1) { page.setRotation(degrees(90)); page.setCropBox(11, 17, 760, 570); }
  }
  imageInput = path.join(directory, 'image-heavy.pdf');
  await writeFile(imageInput, await document.save());
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function compress(input, output, preset) {
  const result = spawnSync(binary, [input, output, preset], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

async function textFrom(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts/') });
  const document = await task.promise;
  try {
    const result = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      result.push((await page.getTextContent()).items.map((item) => item.str ?? '').join(' ').trim());
      page.cleanup();
    }
    return result;
  } finally { await task.destroy(); }
}

test('all three Mac presets reduce an image-heavy PDF and preserve searchable text, geometry, and rotation', macOnly, async (context) => {
  const originalBytes = await readFile(imageInput);
  const original = await PDFDocument.load(originalBytes);
  const originalText = await textFrom(originalBytes);
  const sizes = [];
  for (const preset of ['high', 'balanced', 'small']) {
    const output = path.join(directory, `${preset}.pdf`);
    const result = compress(imageInput, output, preset);
    const bytes = await readFile(output);
    assert.equal(result.originalBytes, originalBytes.length);
    assert.equal(result.outputBytes, bytes.length);
    assert.equal(result.preset, preset);
    assert.equal(result.applied, true, `${preset} did not reduce image data`);
    assert.ok(bytes.length < originalBytes.length * 0.8, `${preset} did not meaningfully compress the fixture`);
    const compressed = await PDFDocument.load(bytes);
    assert.equal(compressed.getPageCount(), original.getPageCount());
    for (let index = 0; index < original.getPageCount(); index += 1) {
      const before = original.getPage(index), after = compressed.getPage(index);
      assert.deepEqual(after.getMediaBox(), before.getMediaBox());
      assert.deepEqual(after.getCropBox(), before.getCropBox());
      assert.equal(after.getRotation().angle, before.getRotation().angle);
    }
    assert.deepEqual(await textFrom(bytes), originalText);
    sizes.push(bytes.length);
  }
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], `Expected monotonic representative compression, got ${sizes}`);
  context.diagnostic(`Representative PDF bytes: original ${originalBytes.length}; high ${sizes[0]}; balanced ${sizes[1]}; small ${sizes[2]}`);
});

test('Mac compressor returns original bytes when a rewrite would be larger', macOnly, async () => {
  const document = await PDFDocument.create();
  document.addPage([320, 480]).drawText('A small searchable document');
  const bytes = await document.save();
  const input = path.join(directory, 'small-source.pdf');
  const output = path.join(directory, 'small-source-compressed.pdf');
  await writeFile(input, bytes);
  const result = compress(input, output, 'balanced');
  const actual = await readFile(output);
  assert.equal(result.applied, false);
  assert.ok(actual.length <= bytes.length);
  assert.deepEqual(actual, Buffer.from(bytes));
  assert.deepEqual(await textFrom(actual), await textFrom(bytes));
});

test('Mac compressor rejects invalid presets, malformed input, and replacing the source', macOnly, async () => {
  const output = path.join(directory, 'must-not-exist.pdf');
  const badPreset = spawnSync(binary, [imageInput, output, 'unknown'], { encoding: 'utf8' });
  assert.notEqual(badPreset.status, 0);
  assert.match(badPreset.stderr, /high, balanced, or small/);
  const invalid = path.join(directory, 'invalid.pdf');
  await writeFile(invalid, '%PDF-1.7\nnot a real document');
  const badInput = spawnSync(binary, [invalid, output, 'small'], { encoding: 'utf8' });
  assert.notEqual(badInput.status, 0);
  assert.match(badInput.stderr, /unreadable/);
  const same = spawnSync(binary, [imageInput, imageInput, 'balanced'], { encoding: 'utf8' });
  assert.notEqual(same.status, 0);
  assert.match(same.stderr, /separate output/);
});
