import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { optimizePdfLosslessly } from '../src/pdf-optimizer.js';

const key = (name) => PDFName.of(name);
const rawStreams = (document) => document.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream);
const exactContent = (stream) => Buffer.from(decodePDFRawStream(stream).decode());

async function text(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)) });
  try {
    const document = await task.promise;
    const result = [];
    for (let index = 1; index <= document.numPages; index += 1) result.push((await (await document.getPage(index)).getTextContent()).items.map((item) => item.str ?? '').join(''));
    return result;
  } finally { await task.destroy(); }
}

test('recompresses stored Flate drawing and Type3 glyph streams without changing decoded content or text', async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.setCropBox(11, 17, 570, 740); page.setRotation(degrees(90));
  page.drawText('Searchable text remains unchanged', { x: 30, y: 700, size: 18, font });
  const drawing = Buffer.from('0 0 100 100 re S\n'.repeat(20_000));
  const form = document.context.register(document.context.stream(deflateSync(drawing, { level: 0 }), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Filter: 'FlateDecode' }));
  page.node.setXObject(key('SyntheticForm'), form);
  const unfiltered = document.context.register(document.context.stream(drawing, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100] }));
  page.node.setXObject(key('UnfilteredForm'), unfiltered);
  const glyph = Buffer.from('600 0 0 0 600 700 d1\n0 0 500 600 re f\n'.repeat(5_000));
  const glyphRef = document.context.register(document.context.stream(deflateSync(glyph, { level: 0 }), { Filter: 'FlateDecode' }));
  const type3 = document.context.register(document.context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 600, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { A: glyphRef }, Encoding: { Type: 'Encoding', Differences: [65, 'A'] }, FirstChar: 65, LastChar: 65, Widths: [600], Resources: {} }));
  page.node.setFontDictionary(key('SyntheticType3'), type3);
  const source = await document.save();
  const unchangedInput = source.slice();
  const before = await PDFDocument.load(source);
  const result = await optimizePdfLosslessly(source);
  const after = await PDFDocument.load(result.bytes);
  assert.equal(result.applied, true);
  assert.ok(result.stats.streamsRecompressed >= 3);
  assert.ok(result.outputBytes < source.length / 4);
  assert.deepEqual(await text(result.bytes), await text(source));
  assert.deepEqual(after.getPage(0).getMediaBox(), before.getPage(0).getMediaBox());
  assert.deepEqual(after.getPage(0).getCropBox(), before.getPage(0).getCropBox());
  assert.equal(after.getPage(0).getRotation().angle, 90);
  assert.deepEqual(source, unchangedInput);
  for (const ref of [form, glyphRef, unfiltered]) {
    const original = before.context.lookup(ref), optimized = after.context.lookup(ref);
    assert.deepEqual(exactContent(optimized), exactContent(original));
    for (const [name, value] of original.dict.entries()) if (name !== key('Length') && name !== key('Filter')) assert.equal(optimized.dict.get(name).toString(), value.toString());
  }
});

test('shares only identical font-program streams while preserving descriptors, widths, and Unicode mappings', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage(); page.drawText('A synthetic font-program deduplication test');
  const fontProgram = new Uint8Array(await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));
  const program1 = document.context.register(document.context.stream(fontProgram, { Length1: fontProgram.length }));
  const program2 = document.context.register(document.context.stream(fontProgram, { Length1: fontProgram.length }));
  const cmap = (mapped) => Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <${mapped}> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`);
  const unicode1 = document.context.register(document.context.stream(cmap('0041')));
  const unicode2 = document.context.register(document.context.stream(cmap('0042')));
  const attributes = { Type: 'FontDescriptor', FontName: 'LiberationSans', Flags: 32, FontBBox: [-500, -300, 1500, 1200], ItalicAngle: 0, Ascent: 900, Descent: -300, CapHeight: 700, StemV: 80 };
  const descriptor1 = document.context.register(document.context.obj({ ...attributes, FontFile2: program1 }));
  const descriptor2 = document.context.register(document.context.obj({ ...attributes, FontFile2: program2 }));
  const fontAttributes = { Type: 'Font', Subtype: 'TrueType', BaseFont: 'LiberationSans', Encoding: 'WinAnsiEncoding', FirstChar: 65, LastChar: 65 };
  const font1 = document.context.register(document.context.obj({ ...fontAttributes, FontDescriptor: descriptor1, Widths: [500], ToUnicode: unicode1 }));
  const font2 = document.context.register(document.context.obj({ ...fontAttributes, FontDescriptor: descriptor2, Widths: [600], ToUnicode: unicode2 }));
  page.node.setFontDictionary(key('DedupFontOne'), font1);
  page.node.setFontDictionary(key('DedupFontTwo'), font2);
  page.node.addContentStream(document.context.register(document.context.flateStream('BT /DedupFontOne 16 Tf 1 0 0 1 40 500 Tm (A) Tj /DedupFontTwo 16 Tf 1 0 0 1 80 500 Tm (A) Tj ET')));
  document.catalog.set(key('SyntheticFontResources'), document.context.obj([font1, font2]));
  document.catalog.set(key('NestedProgramRefs'), document.context.obj({ Refs: [program1, program2] }));
  const source = await document.save();
  const result = await optimizePdfLosslessly(source);
  const after = await PDFDocument.load(result.bytes);
  assert.equal(result.applied, true);
  assert.equal(result.stats.duplicateFontPrograms, 1);
  assert.equal(after.context.lookup(descriptor1).get(key('FontFile2')).toString(), after.context.lookup(descriptor2).get(key('FontFile2')).toString());
  assert.equal(after.context.lookup(program2), undefined);
  assert.deepEqual(exactContent(after.context.lookup(program1)), Buffer.from(fontProgram));
  assert.equal(after.context.lookup(font1).get(key('Widths')).toString(), '[ 500 ]');
  assert.equal(after.context.lookup(font2).get(key('Widths')).toString(), '[ 600 ]');
  assert.equal(after.context.lookup(font1).get(key('ToUnicode')).toString(), unicode1.toString());
  assert.equal(after.context.lookup(font2).get(key('ToUnicode')).toString(), unicode2.toString());
  for (const ref of [unicode1, unicode2]) assert.deepEqual(exactContent(after.context.lookup(ref)), exactContent((await PDFDocument.load(source)).context.lookup(ref)));
  const nested = after.catalog.lookup(key('NestedProgramRefs'), PDFDict).lookup(key('Refs'), PDFArray);
  assert.equal(nested.get(0).toString(), nested.get(1).toString());
  assert.deepEqual(await text(result.bytes), await text(source));
});

test('leaves predictors, JPEG, JPX, LZW, external streams, and invalid Flate bytes untouched', async () => {
  const document = await PDFDocument.create(); document.addPage().drawText('Unchanged unsupported streams');
  const cases = [
    { Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: 3 } },
    { Filter: 'DCTDecode' }, { Filter: 'JPXDecode' }, { Filter: 'LZWDecode' },
    { F: PDFString.of('external-resource'), Filter: 'FlateDecode' },
    { Filter: 'FlateDecode' },
  ];
  const refs = cases.map((dictionary) => document.context.register(document.context.stream(Buffer.from('not valid compressed image bytes'), dictionary)));
  const source = await document.save();
  const before = await PDFDocument.load(source);
  const result = await optimizePdfLosslessly(source);
  const after = await PDFDocument.load(result.bytes);
  for (const ref of refs) {
    assert.deepEqual(after.context.lookup(ref).contents, before.context.lookup(ref).contents);
    for (const [name, value] of before.context.lookup(ref).dict.entries()) if (name !== key('Length')) assert.equal(after.context.lookup(ref).dict.get(name).toString(), value.toString());
  }
});

test('skips a decompression bomb at the per-stream limit without changing its encoded bytes', async () => {
  const document = await PDFDocument.create(); document.addPage();
  const encoded = deflateSync(new Uint8Array(33 * 1024 * 1024));
  const ref = document.context.register(document.context.stream(encoded, { Filter: 'FlateDecode' }));
  const result = await optimizePdfLosslessly(await document.save());
  const output = await PDFDocument.load(result.bytes);
  assert.deepEqual(output.context.lookup(ref).contents, new Uint8Array(encoded));
  assert.equal(inflateSync(output.context.lookup(ref).contents).length, 33 * 1024 * 1024);
});

test('returns byte-identical original when no optimization shrinks it and rejects bad PDFs', async () => {
  const document = await PDFDocument.create(); document.addPage();
  const source = await document.save();
  const result = await optimizePdfLosslessly(source);
  assert.equal(result.applied, false);
  assert.strictEqual(result.bytes, source);
  assert.deepEqual(result.stats, { streamsRecompressed: 0, duplicateFontPrograms: 0 });
  await assert.rejects(optimizePdfLosslessly(new Uint8Array()), /empty/);
  await assert.rejects(optimizePdfLosslessly(new TextEncoder().encode('not a pdf')), /could not be read/);
  const empty = await PDFDocument.create();
  await assert.rejects(optimizePdfLosslessly(await empty.save({ addDefaultPage: false })), /no pages/);
  const encrypted = await PDFDocument.create(); encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
  await assert.rejects(optimizePdfLosslessly(await encrypted.save()), /Password-protected/);
});
