import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { optimizePdfAggressively } from '../src/pdf-aggressive.js';

const key = (name) => PDFName.of(name);
const standardFontDataUrl = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));

async function render(bytes, pageNumber = 1, background = 'rgba(0,0,0,0)') {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl });
  try {
    const page = await (await task.promise).getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, background }).promise;
    return canvas;
  } finally { await task.destroy(); }
}
const renderForm = async (bytes) => new Uint8Array(await (await render(bytes)).encode('png'));

async function text(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl });
  try {
    const document = await task.promise, pages = [];
    for (let index = 1; index <= document.numPages; index += 1) pages.push((await (await document.getPage(index)).getTextContent()).items.map((item) => item.str ?? '').join(''));
    return pages;
  } finally { await task.destroy(); }
}

async function fixture({ nestedText = false, directText = false, mixedColors = false, appearance = false, renderingIntent = false, glyphContext = false } = {}) {
  const document = await PDFDocument.create(), context = document.context;
  const page = document.addPage([300, 220]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 300, height: 220, color: rgb(0.7, 0.8, 0.9) });
  page.drawText('Selectable synthetic text', { x: 20, y: 190, font, size: 12 });
  const second = document.addPage([320, 240]);
  second.setCropBox(5, 10, 300, 220); second.setRotation(degrees(90));
  const mask = context.register(context.flateStream('q /Half gs 1 g 10 20 100 100 re f Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [10, 20, 210, 120], Group: { S: 'Transparency' },
    Resources: { ExtGState: { Half: { ca: 0.5 } } },
  }));
  let state = 12345;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  let content = 'q 0.9 0.1 0.2 scn 10 20 200 100 re f /Mask gs 0.1 0.7 0.3 scn 10 20 200 100 re f Q\n';
  for (let index = 0; index < 14_000; index += 1) content += `q ${random().toFixed(10)} ${random().toFixed(10)} ${random().toFixed(10)} scn ${(10 + random() * 199).toFixed(10)} ${(20 + random() * 99).toFixed(10)} 0.5 0.5 re f Q\n`;
  const resources = context.obj({ ExtGState: { Mask: { SMask: { Type: 'Mask', S: 'Alpha', G: mask } } } });
  if (directText) content += 'BT /F1 10 Tf 3 Tr (Invisible text is still text) Tj ET\n';
  if (nestedText) {
    const child = context.register(context.flateStream('BT /F1 10 Tf 3 Tr (Nested invisible text) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: { Font: { F1: font.ref } } }));
    resources.set(key('XObject'), context.obj({ Child: child }));
    content += '/Child Do\n';
  }
  const form = context.register(context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [10, 20, 210, 120], Group: { S: 'Transparency' }, Resources: resources }));
  page.node.setXObject(key('LargeGraphics'), form);
  // The form intentionally inherits RGB: scn without cs was the original color regression.
  page.node.addContentStream(context.register(context.flateStream(`q /DeviceRGB cs ${renderingIntent ? '/AbsoluteColorimetric ri' : ''} 1 0 0 1 30 20 cm /LargeGraphics Do Q`)));
  if (glyphContext) {
    const glyph = context.register(context.flateStream('600 0 0 0 600 700 d1 /LargeGraphics Do'));
    const glyphFont = context.register(context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 600, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 65, LastChar: 65, Widths: [600], Encoding: { Type: 'Encoding', Differences: [65, 'A'] }, CharProcs: { A: glyph }, Resources: { XObject: { LargeGraphics: form } } }));
    page.node.setFontDictionary(key('GlyphFont'), glyphFont);
  }
  const external = context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 185, 180, 200], Border: [0, 0, 0], A: { S: 'URI', URI: 'https://example.test/synthetic' } }));
  const internal = context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 160, 180, 175], Border: [0, 0, 0], Dest: [second.ref, 'Fit'] }));
  if (appearance) context.lookup(external).set(key('AP'), context.obj({ N: form }));
  page.node.set(key('Annots'), context.obj([external, internal]));
  if (mixedColors) {
    second.node.setXObject(key('LargeGraphics'), form);
    second.node.addContentStream(context.register(context.flateStream('q /DeviceCMYK cs /LargeGraphics Do Q')));
  }
  return { bytes: await document.save(), form, external, internal };
}

test('compresses graphics with inherited RGB, alpha masks, and colored background while retaining text, links, and geometry', async () => {
  const { bytes, form, external, internal } = await fixture();
  const result = await optimizePdfAggressively(bytes, { renderForm });
  assert.equal(result.applied, true); assert.equal(result.stats.rasterizedForms, 1);
  assert.ok(result.bytes.length < bytes.length / 2);
  assert.deepEqual(await text(result.bytes), await text(bytes));
  const before = await PDFDocument.load(bytes), after = await PDFDocument.load(result.bytes);
  for (const ref of [external, internal]) assert.equal(after.context.lookup(ref).toString(), before.context.lookup(ref).toString());
  assert.equal(after.getPage(0).node.Annots().toString(), before.getPage(0).node.Annots().toString());
  for (let index = 0; index < before.getPageCount(); index += 1) {
    assert.deepEqual(after.getPage(index).getMediaBox(), before.getPage(index).getMediaBox());
    assert.deepEqual(after.getPage(index).getCropBox(), before.getPage(index).getCropBox());
    assert.equal(after.getPage(index).getRotation().angle, before.getPage(index).getRotation().angle);
  }
  assert.equal(after.context.lookup(form).dict.get(key('Group')).toString(), before.context.lookup(form).dict.get(key('Group')).toString());
  const first = (await render(bytes, 1, 'white')).getContext('2d').getImageData(0, 0, 600, 440).data;
  const second = (await render(result.bytes, 1, 'white')).getContext('2d').getImageData(0, 0, 600, 440).data;
  let error = 0;
  for (let index = 0; index < first.length; index += 1) error += Math.abs(first[index] - second[index]);
  assert.ok(error / first.length < 0.5, `Mean pixel difference ${error / first.length} changed inherited color or transparency`);
});

test('does not rasterize direct or nested invisible text, mixed color contexts, annotation appearances, glyph contexts, or custom rendering intents', async () => {
  for (const options of [{ directText: true }, { nestedText: true }, { mixedColors: true }, { appearance: true }, { renderingIntent: true }, { glyphContext: true }]) {
    const { bytes } = await fixture(options);
    let called = false;
    const result = await optimizePdfAggressively(bytes, { renderForm: async () => { called = true; throw new Error('Unexpected rasterization'); } });
    assert.equal(called, false, JSON.stringify(options));
    assert.equal(result.applied, false); assert.strictEqual(result.bytes, bytes);
  }
});

test('keeps byte-identical source when graphics rendering has no size benefit or fails', async () => {
  const { bytes } = await fixture();
  for (const callback of [async () => new Uint8Array(bytes.length * 2), async () => { throw new Error('Renderer unavailable'); }]) {
    const result = await optimizePdfAggressively(bytes, { renderForm: callback });
    assert.equal(result.applied, false); assert.strictEqual(result.bytes, bytes);
    assert.equal(result.stats.rasterizedForms, 0);
  }
  await assert.rejects(optimizePdfAggressively(new Uint8Array(), { renderForm }), /empty/);
  await assert.rejects(optimizePdfAggressively(bytes), /unavailable/);
});
