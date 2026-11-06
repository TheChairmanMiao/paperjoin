import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { assemblePdf, inspectPdf } from '../src/pdf-engine.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const jpeg = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q==', 'base64'));

async function makePdf() {
  const document = await PDFDocument.create();
  const first = document.addPage([320, 480]);
  first.drawRectangle({ x: 12, y: 20, width: 40, height: 60, color: rgb(1, 0, 0) });
  const second = document.addPage([640, 360]);
  second.setRotation(degrees(90));
  second.setCropBox(10, 15, 600, 330);
  second.drawRectangle({ x: 70, y: 80, width: 25, height: 35, color: rgb(0, 0, 1) });
  return new Uint8Array(await document.save());
}

test('inspect reports source sizes, original rotations, and form presence', async () => {
  assert.deepEqual(await inspectPdf(await makePdf()), {
    pageCount: 2,
    dimensions: [
      { width: 320, height: 480, rotation: 0 },
      { width: 640, height: 360, rotation: 90 },
    ],
    hasFormFields: false,
  });
});

test('merge honors page order and duplication while preserving page boxes and vector streams', async () => {
  const original = await makePdf();
  const output = await assemblePdf([{ id: 'source', kind: 'pdf', bytes: original }], [
    { sourceId: 'source', pageIndex: 1, rotation: 90 },
    { sourceId: 'source', pageIndex: 0, rotation: -90 },
    { sourceId: 'source', pageIndex: 1, rotation: 0 },
  ], { title: 'Test packet' });
  const result = await PDFDocument.load(output);
  assert.equal(result.getTitle(), 'Test packet');
  assert.deepEqual(result.getPages().map((page) => [page.getWidth(), page.getHeight(), page.getRotation().angle]), [
    [640, 360, 180], [320, 480, 270], [640, 360, 90],
  ]);
  assert.deepEqual(result.getPage(0).getCropBox(), { x: 10, y: 15, width: 600, height: 330 });
  const source = await PDFDocument.load(original);
  const streams = (page, document) => page.node.Contents().asArray().map((reference) => Buffer.from(document.context.lookup(reference).contents).toString('base64'));
  assert.deepEqual(streams(result.getPage(0), result), streams(source.getPage(1), source));
  assert.deepEqual(streams(result.getPage(1), result), streams(source.getPage(0), source));
});

test('copies shared PDF fonts and images once while retaining independent duplicate-page rotations', async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const image = await source.embedPng(png);
  for (let index = 0; index < 2; index += 1) {
    const page = source.addPage([300 + index, 400]);
    page.drawText(`Page ${index + 1}`, { font });
    page.drawImage(image, { x: 10, y: 10, width: 20, height: 20 });
  }
  const result = await PDFDocument.load(await assemblePdf([
    { id: 'shared', kind: 'pdf', bytes: new Uint8Array(await source.save()) },
    { id: 'separator', kind: 'png', bytes: png },
  ], [
    { sourceId: 'shared', pageIndex: 1, rotation: 90 },
    { sourceId: 'separator', pageIndex: 0 },
    { sourceId: 'shared', pageIndex: 0, rotation: 180 },
    { sourceId: 'shared', pageIndex: 1, rotation: 270 },
  ]));
  assert.deepEqual(result.getPages().map((page) => [page.getWidth(), page.getRotation().angle]), [
    [301, 90], [0.75, 0], [300, 180], [301, 270],
  ]);
  const resourceRefs = (page, category) => page.node.Resources().lookup(PDFName.of(category)).values().map(String);
  const pdfPages = [result.getPage(0), result.getPage(2), result.getPage(3)];
  assert.equal(new Set(pdfPages.flatMap((page) => resourceRefs(page, 'Font'))).size, 1);
  assert.equal(new Set(pdfPages.flatMap((page) => resourceRefs(page, 'XObject'))).size, 1);
  assert.notEqual(pdfPages[0].node, pdfPages[2].node);
});

test('PNG and JPEG embed as original-size pages and respect image page rotation', async () => {
  const result = await PDFDocument.load(await assemblePdf([
    { id: 'png', kind: 'png', bytes: png },
    { id: 'jpg', kind: 'jpg', bytes: jpeg },
  ], [
    { sourceId: 'png', pageIndex: 0, rotation: 90 },
    { sourceId: 'jpg', pageIndex: 0, rotation: 0 },
  ], { imagePageSize: 'original', imageMargin: 12 }));
  assert.equal(result.getPageCount(), 2);
  assert.deepEqual(result.getPages().map((page) => [page.getWidth(), page.getHeight(), page.getRotation().angle]), [[24.75, 24.75, 90], [24.75, 24.75, 0]]);
  for (const page of result.getPages()) {
    assert.equal(page.node.Resources().lookup(PDFName.of('XObject')).keys().length, 1);
  }
});

test('fixed image sizes use A4 or Letter with centered content', async () => {
  for (const [size, width, height] of [['a4', 595.2755905511812, 841.8897637795277], ['letter', 612, 792]]) {
    const result = await PDFDocument.load(await assemblePdf(
      [{ id: 'image', kind: 'png', bytes: png }],
      [{ sourceId: 'image', pageIndex: 0 }],
      { imagePageSize: size, imageMargin: 18 },
    ));
    assert.equal(result.getPage(0).getWidth(), width);
    assert.equal(result.getPage(0).getHeight(), height);
  }
});

test('interactive forms and orphaned widgets are detected and export is refused', async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const field = document.getForm().createTextField('name');
  field.setText('Filled value');
  field.addToPage(page, { x: 10, y: 10, width: 100, height: 30 });
  const bytes = new Uint8Array(await document.save());
  assert.equal((await inspectPdf(bytes)).hasFormFields, true);
  await assert.rejects(assemblePdf([{ id: 'form', kind: 'pdf', bytes }], [{ sourceId: 'form', pageIndex: 0 }]), /flattened copy/);

  document.catalog.delete(PDFName.of('AcroForm'));
  const orphaned = new Uint8Array(await document.save());
  assert.equal((await inspectPdf(orphaned)).hasFormFields, true);
  await assert.rejects(assemblePdf([{ id: 'form', kind: 'pdf', bytes: orphaned }], [{ sourceId: 'form', pageIndex: 0 }]), /flattened copy/);
});

test('XFA forms are detected without using the form API that deletes XFA data', async () => {
  const document = await PDFDocument.create();
  document.addPage();
  const xfa = document.context.register(document.context.stream('<xfa/>'));
  document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ XFA: xfa }));
  const bytes = new Uint8Array(await document.save());
  assert.equal((await inspectPdf(bytes)).hasFormFields, true);
  await assert.rejects(assemblePdf([{ id: 'xfa', kind: 'pdf', bytes }], [{ sourceId: 'xfa', pageIndex: 0 }]), /flattened copy/);
});

test('empty, corrupt, and encrypted PDFs are rejected clearly', async () => {
  await assert.rejects(inspectPdf(new Uint8Array()), /empty/);
  await assert.rejects(inspectPdf(new TextEncoder().encode('not a pdf')), /could not be read/);
  const emptyDocument = await PDFDocument.create();
  await assert.rejects(inspectPdf(new Uint8Array(await emptyDocument.save({ addDefaultPage: false }))), /no pages/);
  const encrypted = await PDFDocument.create();
  encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard', V: 1, R: 2 }));
  await assert.rejects(inspectPdf(new Uint8Array(await encrypted.save())), /Password-protected/);
});

test('invalid export inputs fail before producing a document', async () => {
  const sources = [{ id: 'valid', kind: 'pdf', bytes: await makePdf() }];
  const pages = [{ sourceId: 'valid', pageIndex: 0 }];
  await assert.rejects(assemblePdf([], pages), /Add a PDF/);
  await assert.rejects(assemblePdf(sources, []), /at least one page/);
  await assert.rejects(assemblePdf(sources, [{ sourceId: 'missing', pageIndex: 0 }]), /source file/);
  await assert.rejects(assemblePdf(sources, [{ sourceId: 'valid', pageIndex: 2 }]), /outside/);
  await assert.rejects(assemblePdf(sources, [{ sourceId: 'valid', pageIndex: -1 }]), /invalid page number/);
  await assert.rejects(assemblePdf(sources, [{ sourceId: 'valid', pageIndex: 0, rotation: 45 }]), /multiple of 90/);
  await assert.rejects(assemblePdf(sources, pages, { imagePageSize: 'legal' }), /Original, A4, or Letter/);
  await assert.rejects(assemblePdf(sources, pages, { imageMargin: -1 }), /margins/);
  await assert.rejects(assemblePdf([...sources, ...sources], pages), /unique/);
  await assert.rejects(assemblePdf([{ id: 'valid', kind: 'docx', bytes: png }], pages), /Only PDF/);
  await assert.rejects(assemblePdf([{ id: 'image', kind: 'png', bytes: png }], [{ sourceId: 'image', pageIndex: 1 }]), /only one page/);
  await assert.rejects(assemblePdf([{ id: 'image', kind: 'png', bytes: new Uint8Array([1, 2, 3]) }], [{ sourceId: 'image', pageIndex: 0 }]), /image could not be read/);
  await assert.rejects(assemblePdf([{ id: 'image', kind: 'png', bytes: png }], [{ sourceId: 'image', pageIndex: 0 }], { imagePageSize: 'letter', imageMargin: 400 }), /no room/);
});
