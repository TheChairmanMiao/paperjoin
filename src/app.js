import { inspectPdf, assemblePdf } from './pdf-engine.js';
import { optimizePdfLosslessly } from './pdf-optimizer.js';
import { optimizePdfAggressively } from './pdf-aggressive.js';
import * as pdfjs from './vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
const $ = (id) => document.getElementById(id);
const sources = new Map();
const thumbnails = new Map();
const pendingThumbnails = new Map();
let pages = [];
let undoPages = null;
let busy = false;
let resultUrl = null;
let exportedPdf = null;
const desktop = window.desktop;
let draggedPageId = null;
let previewRequest = 0;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const MAX_PAGES = 500;
const MAX_IMAGE_PIXELS = 40_000_000;
const compressionPresets = {
  none: { label: 'Original quality', description: 'Keeps the original image quality.' },
  high: { label: 'High quality', description: 'Light compression. Best for printing and detailed images.' },
  balanced: { label: 'Balanced', description: 'Smaller files with good image quality. Best for everyday sharing.' },
  small: { label: 'Smaller file', description: 'Stronger image compression. Images may look softer.' },
  aggressive: { label: 'Aggressive', description: 'Reduces fine detail in complex graphics for much smaller files.' },
};
const imageSettings = () => ({ imagePageSize: $('image-size').value, imageMargin: Number($('image-margin').value) });
const pageWord = (count) => count === 1 ? 'page' : 'pages';
const formatBytes = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
function announce(message, success = false) {
  $('status-message').textContent = message;
  $('status-message').classList.toggle('status-success', success);
}
function showErrors(errors) {
  $('error-list').replaceChildren();
  $('error-list').hidden = errors.length === 0;
  for (const message of errors) {
    const item = document.createElement('p');
    item.className = 'error-item';
    item.textContent = message;
    $('error-list').append(item);
  }
}
function invalidateResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  exportedPdf = null;
  $('result-panel').hidden = true;
  $('compression-result').hidden = true;
  $('compression-result').textContent = '';
  $('download-again').removeAttribute('href');
}
function activeSourceIds() { return new Set(pages.map((page) => page.sourceId)); }
function disposeUnusedSources() {
  const keep = new Set([...activeSourceIds(), ...(undoPages ?? []).map((page) => page.sourceId)]);
  for (const [id, source] of sources) {
    if (keep.has(id)) continue;
    sources.delete(id);
    source.pdf?.destroy().catch(() => {});
    for (const [key, url] of thumbnails) {
      if (key.startsWith(`${id}/`)) { URL.revokeObjectURL(url); thumbnails.delete(key); }
    }
  }
}
function snapshot() { undoPages = pages.map((page) => ({ ...page })); }
function editPages(nextPages, message, focus) {
  if (busy) return;
  snapshot();
  pages = nextPages;
  invalidateResult();
  disposeUnusedSources();
  render();
  announce(message);
  if (focus) focusCard(focus.id, focus.action);
}
function focusCard(id, action = 'preview') {
  const card = [...$('pages-grid').children].find((node) => node.dataset.pageId === id);
  card?.querySelector(`[data-action="${action}"]`)?.focus();
}
function actionButton(action, label, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled || busy;
  button.append(icon({ left: 'left', right: 'right', rotate: 'rotate', remove: 'trash' }[action]));
  return button;
}
function render() {
  const count = pages.length;
  desktop?.setWorkspaceHasFiles(count > 0);
  const activeIds = activeSourceIds();
  const activeSources = [...sources.values()].filter((source) => activeIds.has(source.id));
  document.body.classList.toggle('has-pages', count > 0);
  document.body.classList.toggle('is-busy', busy);
  $('empty-state').hidden = count > 0;
  $('pages-grid').hidden = count === 0;
  $('workspace-summary').textContent = count ? `${count} ${pageWord(count)} · ${activeSources.length} ${activeSources.length === 1 ? 'file' : 'files'}` : 'Your workspace is ready';
  $('export-summary').textContent = count ? `${count} ${pageWord(count)} in your combined PDF` : 'Add files to get started';
  $('clear-all').disabled = busy || count === 0;
  $('undo-button').hidden = undoPages === null;
  $('undo-button').disabled = busy;
  $('add-files').disabled = busy;
  $('add-more').disabled = busy;
  $('file-input').disabled = busy;
  $('filename').disabled = busy;
  $('compression').disabled = !!busy || !desktop;
  $('compression-description').textContent = compressionPresets[$('compression').value].description;
  $('compression-help').textContent = $('compression').value === 'aggressive'
    ? 'Selectable text and links are kept. Detailed graphics may look softer when enlarged.'
    : 'Works on PDFs and images. Existing selectable text is preserved.';
  const hasImages = activeSources.some((source) => source.kind !== 'pdf');
  $('image-size').disabled = busy || !hasImages;
  $('image-margin').disabled = busy || !hasImages;
  $('export-button').disabled = busy || count === 0;
  $('export-label').textContent = busy === 'export' ? 'Creating your PDF…' : busy === 'save' ? 'Saving PDF…' : busy === 'compress' ? 'Compressing PDF…' : 'Export PDF';
  $('export-form').setAttribute('aria-busy', ['export', 'compress', 'save'].includes(busy) ? 'true' : 'false');
  $('dropzone').setAttribute('aria-busy', busy === 'import' ? 'true' : 'false');
  $('files-list').replaceChildren();
  for (const source of activeSources) {
    const row = document.createElement('div');
    row.className = 'source-row';
    const dot = document.createElement('span');
    dot.className = `source-dot source-${source.kind}`;
    dot.append(icon('file'));
    const text = document.createElement('div');
    text.className = 'source-text';
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = source.name;
    name.title = source.name;
    const detail = document.createElement('span');
    detail.className = 'source-detail';
    const remaining = pages.filter((page) => page.sourceId === source.id).length;
    detail.textContent = `${remaining} ${pageWord(remaining)} · ${formatBytes(source.bytes.length)}`;
    text.append(name, detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'source-remove icon-button';
    remove.disabled = !!busy;
    remove.dataset.sourceId = source.id;
    remove.title = `Remove ${source.name}`;
    remove.setAttribute('aria-label', `Remove file ${source.name}`);
    remove.append(icon('close'));
    row.append(dot, text, remove);
    $('files-list').append(row);
  }
  observer.disconnect();
  $('pages-grid').replaceChildren();
  pages.forEach((page, index) => {
    const source = sources.get(page.sourceId);
    const card = document.createElement('article');
    card.className = 'page-card';
    card.dataset.pageId = page.id;
    card.draggable = !busy;
    card.setAttribute('aria-label', `Page ${index + 1}: ${source.name}, source page ${page.pageIndex + 1}`);
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'page-thumb';
    thumb.dataset.action = 'preview';
    thumb.disabled = !!busy;
    thumb.setAttribute('aria-label', `Preview page ${index + 1}`);
    const visual = document.createElement('span');
    visual.className = 'page-visual';
    const image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    const cached = thumbnails.get(thumbnailKey(page));
    if (cached) image.src = cached;
    else visual.setAttribute('aria-busy', 'true');
    visual.append(image);
    const badge = document.createElement('span');
    badge.className = 'page-number';
    badge.textContent = String(index + 1).padStart(2, '0');
    thumb.append(visual, badge);
    const meta = document.createElement('div');
    meta.className = 'page-meta';
    const name = document.createElement('span');
    name.className = 'page-source';
    name.textContent = source.name;
    name.title = source.name;
    const number = document.createElement('span');
    number.className = 'page-source-detail';
    number.textContent = source.kind === 'pdf' ? `Page ${page.pageIndex + 1} of ${source.pageCount}` : (source.displayKind ?? source.kind).toUpperCase() === 'JPG' ? 'JPEG image' : 'PNG image';
    meta.append(name, number);
    const actions = document.createElement('div');
    actions.className = 'page-actions';
    const moves = document.createElement('div');
    moves.className = 'move-controls';
    moves.append(actionButton('left', `Move page ${index + 1} earlier`, index === 0), actionButton('right', `Move page ${index + 1} later`, index === count - 1));
    actions.append(moves, actionButton('rotate', `Rotate page ${index + 1} clockwise`), actionButton('remove', `Remove page ${index + 1}`));
    card.append(thumb, meta, actions);
    $('pages-grid').append(card);
    if (!cached) observer.observe(card);
  });
}
function thumbnailKey(page) {
  const source = sources.get(page.sourceId);
  const settings = source?.kind === 'pdf' ? '' : `/${$('image-size').value}/${$('image-margin').value}`;
  return `${page.sourceId}/${page.pageIndex}/${page.rotation}${settings}`;
}
function canvasBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('This page is too large to preview.')), type, quality));
}
async function renderCompressionGraphic(bytes, { width, height }) {
  const scale = 2; // 144 dpi keeps small text in outlined graphics readable.
  const pixelWidth = Math.max(1, Math.ceil(width * scale));
  const pixelHeight = Math.max(1, Math.ceil(height * scale));
  if (pixelWidth * pixelHeight > 16_000_000 || Math.max(pixelWidth, pixelHeight) > 8192) {
    throw new Error('This graphic is too large to compress safely.');
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
  const canvas = document.createElement('canvas');
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale }), background: 'rgba(0, 0, 0, 0)' }).promise;
    return new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    await task.destroy();
  }
}
async function pageImage(page, maxDimension) {
  const source = sources.get(page.sourceId);
  if (!source) throw new Error('Source removed.');
  const settings = imageSettings();
  const canvas = document.createElement('canvas');
  if (source.kind === 'pdf') {
    const pdfPage = await source.pdf.getPage(page.pageIndex + 1);
    const rotation = ((pdfPage.rotate + page.rotation) % 360 + 360) % 360;
    const initial = pdfPage.getViewport({ scale: 1, rotation });
    const viewport = pdfPage.getViewport({ scale: Math.min(maxDimension / initial.width, maxDimension / initial.height), rotation });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    try {
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'white' }).promise;
    } finally { pdfPage.cleanup(); }
  } else {
    const bitmap = await createImageBitmap(new Blob([source.bytes], { type: source.kind === 'png' ? 'image/png' : 'image/jpeg' }));
    try {
      const { imagePageSize, imageMargin: margin } = settings;
      const [w, h] = imagePageSize === 'original' ? [bitmap.width * 0.75 + 2 * margin, bitmap.height * 0.75 + 2 * margin] : imagePageSize === 'a4' ? [595.2755905511812, 841.8897637795277] : [612, 792];
      const quarter = page.rotation % 180 !== 0;
      const scale = maxDimension / Math.max(w, h);
      canvas.width = Math.max(1, Math.ceil((quarter ? h : w) * scale));
      canvas.height = Math.max(1, Math.ceil((quarter ? w : h) * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(page.rotation * Math.PI / 180);
      ctx.scale(scale, scale);
      const fit = Math.min((w - 2 * margin) / bitmap.width, (h - 2 * margin) / bitmap.height);
      const dw = bitmap.width * fit, dh = bitmap.height * fit;
      ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
    } finally { bitmap.close(); }
  }
  const blob = await canvasBlob(canvas);
  canvas.width = 0; canvas.height = 0;
  return blob;
}
async function loadThumbnail(id) {
  const page = pages.find((item) => item.id === id);
  if (!page) return;
  const key = thumbnailKey(page);
  try {
    if (!thumbnails.has(key)) {
      if (!pendingThumbnails.has(key)) pendingThumbnails.set(key, pageImage({ ...page }, 440));
      const blob = await pendingThumbnails.get(key);
      pendingThumbnails.delete(key);
      if (!sources.has(page.sourceId)) return;
      if (!thumbnails.has(key)) thumbnails.set(key, URL.createObjectURL(blob));
    }
    const current = pages.find((item) => item.id === id);
    const card = [...$('pages-grid').children].find((node) => node.dataset.pageId === id);
    if (!current || thumbnailKey(current) !== key || !card) return;
    card.querySelector('img').src = thumbnails.get(key);
    card.querySelector('.page-visual').removeAttribute('aria-busy');
  } catch {
    pendingThumbnails.delete(key);
    const card = [...$('pages-grid').children].find((node) => node.dataset.pageId === id);
    const current = pages.find((item) => item.id === id);
    if (card && current && thumbnailKey(current) === key) {
      const visual = card.querySelector('.page-visual');
      visual.removeAttribute('aria-busy');
      visual.textContent = 'Preview unavailable';
    }
  }
}
const thumbQueue = [];
let activeThumbs = 0;
function drainThumbQueue() {
  while (activeThumbs < 2 && thumbQueue.length) {
    const id = thumbQueue.shift();
    activeThumbs++;
    loadThumbnail(id).finally(() => { activeThumbs--; drainThumbQueue(); });
  }
}
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) {
    observer.unobserve(entry.target);
    thumbQueue.push(entry.target.dataset.pageId);
  }
  drainThumbQueue();
}, { rootMargin: '300px' });

function jpegOrientation(bytes) {
  // EXIF orientations other than 1 must be baked into image pixels before PDF embedding.
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 < bytes.length && view.getUint8(offset) === 0xff) {
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
        const tiff = offset + 10;
        const little = view.getUint16(tiff) === 0x4949;
        if (view.getUint16(tiff + 2, little) !== 42) break;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        const count = view.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const field = ifd + 2 + i * 12;
          if (view.getUint16(field, little) === 0x0112) return view.getUint16(field + 8, little);
        }
      }
      offset += length + 2;
    }
  } catch { /* Malformed EXIF does not change the original image bytes. */ }
  return 1;
}
function detectKind(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) return 'pdf';
  throw new Error('Use a PDF, PNG, or JPEG file.');
}
async function importFile(file) {
  if (!file.size) throw new Error('This file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose a file smaller than 50 MB.');
  let bytes = new Uint8Array(await file.arrayBuffer());
  let kind = detectKind(bytes);
  const source = { id: crypto.randomUUID(), name: file.name, kind, displayKind: kind, bytes, pageCount: 1 };
  let pdf;
  let loadingTask;
  try {
    if (kind === 'pdf') {
      const info = await inspectPdf(bytes);
      if (info.hasFormFields) throw new Error('This PDF contains interactive form fields. Save a flattened copy first to preserve filled values.');
      source.pageCount = info.pageCount;
      if (pages.length + source.pageCount > MAX_PAGES) throw new Error('Keep the workspace to 500 pages or fewer.');
      loadingTask = pdfjs.getDocument({
        data: bytes.slice(),
        cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
        wasmUrl: new URL('./vendor/wasm/', import.meta.url).href,
        iccUrl: new URL('./vendor/iccs/', import.meta.url).href,
        isEvalSupported: false,
        stopAtErrors: true,
        enableXfa: false,
      });
      pdf = await loadingTask.promise;
      source.pdf = pdf;
    } else {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      try {
        if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) throw new Error('This image is larger than 40 megapixels. Resize it before adding it.');
        source.width = bitmap.width; source.height = bitmap.height;
        if (kind === 'jpg' && jpegOrientation(bytes) !== 1) {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          bytes = new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer());
          canvas.width = 0; canvas.height = 0;
          source.kind = 'png'; source.bytes = bytes;
        }
      } finally { bitmap.close(); }
    }
    if (pages.length + source.pageCount > MAX_PAGES) throw new Error('Keep the workspace to 500 pages or fewer.');
    const total = [...sources.values()].reduce((sum, item) => sum + item.bytes.length, 0) + source.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('This workspace is limited to 150 MB. Remove some files first.');
    sources.set(source.id, source);
    for (let index = 0; index < source.pageCount; index++) pages.push({ id: crypto.randomUUID(), sourceId: source.id, pageIndex: index, rotation: 0 });
  } catch (error) {
    if (loadingTask) loadingTask.destroy().catch(() => {});
    else pdf?.destroy().catch(() => {});
    throw error;
  }
}
async function addFiles(list) {
  if (busy || !list.length) return;
  const files = [...list];
  busy = 'import';
  invalidateResult();
  showErrors([]);
  snapshot();
  disposeUnusedSources();
  const errors = [];
  const initialCount = pages.length;
  render();
  for (let index = 0; index < files.length; index++) {
    announce(`Adding file ${index + 1} of ${files.length}: ${files[index].name}`);
    try { await importFile(files[index]); }
    catch (error) { errors.push(`${files[index].name}: ${error.message || 'This file could not be added.'}`); }
  }
  if (pages.length === initialCount) undoPages = null;
  busy = false;
  $('file-input').value = '';
  disposeUnusedSources();
  render();
  showErrors(errors);
  const added = pages.length - initialCount;
  announce(added ? `Added ${added} ${pageWord(added)}. Arrange them below, then export.` : 'No files were added. Check the messages above.');
}

async function chooseFiles() {
  if (busy) return;
  if (!desktop) { $('file-input').click(); return; }
  busy = 'select'; render();
  try {
    const selection = await desktop.openFiles();
    busy = false;
    if (selection.files.length) await addFiles(selection.files.map((file) => new File([file.bytes], file.name)));
    else render();
    if (selection.errors.length) showErrors([...Array.from($('error-list').children, (node) => node.textContent), ...selection.errors]);
  } catch (error) { busy = false; render(); showErrors([error.message || 'The files could not be opened.']); }
}
$('add-files').addEventListener('click', chooseFiles);
$('add-more').addEventListener('click', chooseFiles);
$('file-input').addEventListener('change', (event) => addFiles(event.target.files));
let dragDepth = 0;
window.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
$('dropzone').addEventListener('dragenter', (event) => {
  if (!event.dataTransfer.types.includes('Files') || busy) return;
  event.preventDefault(); dragDepth++; $('dropzone').classList.add('drop-active');
});
$('dropzone').addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }
});
$('dropzone').addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').classList.remove('drop-active'); });
$('dropzone').addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; $('dropzone').classList.remove('drop-active');
  if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
});
$('files-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-source-id]');
  if (!button || busy) return;
  const source = sources.get(button.dataset.sourceId);
  editPages(pages.filter((page) => page.sourceId !== source.id), `Removed ${source.name}. Undo is available.`);
});
$('pages-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  const card = button?.closest('[data-page-id]');
  if (!button || !card || busy) return;
  const index = pages.findIndex((page) => page.id === card.dataset.pageId);
  if (index < 0) return;
  const page = pages[index];
  const action = button.dataset.action;
  if (action === 'preview') { openPreview(page, index); return; }
  const next = pages.map((item) => ({ ...item }));
  if (action === 'rotate') {
    next[index].rotation = (next[index].rotation + 90) % 360;
    editPages(next, `Rotated page ${index + 1} clockwise.`, { id: page.id, action });
  } else if (action === 'remove') {
    next.splice(index, 1);
    editPages(next, `Removed page ${index + 1}. Undo is available.`, { id: next[Math.min(index, next.length - 1)]?.id, action: 'remove' });
  } else {
    const to = index + (action === 'left' ? -1 : 1);
    if (to < 0 || to >= pages.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    const nextAction = (action === 'left' && to === 0) ? 'right' : (action === 'right' && to === next.length - 1) ? 'left' : action;
    editPages(next, `Moved page ${index + 1} to position ${to + 1}.`, { id: page.id, action: nextAction });
  }
});
$('pages-grid').addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-page-id]');
  if (!card || busy) { event.preventDefault(); return; }
  draggedPageId = card.dataset.pageId;
  event.dataTransfer.setData('text/plain', draggedPageId);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
$('pages-grid').addEventListener('dragover', (event) => {
  if (!draggedPageId || busy) return;
  const card = event.target.closest('[data-page-id]');
  if (!card) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  for (const node of $('pages-grid').children) node.classList.toggle('drag-target', node === card && node.dataset.pageId !== draggedPageId);
});
$('pages-grid').addEventListener('drop', (event) => {
  if (!draggedPageId || busy) return;
  event.preventDefault();
  const target = event.target.closest('[data-page-id]');
  if (!target) return;
  const from = pages.findIndex((page) => page.id === draggedPageId);
  const to = pages.findIndex((page) => page.id === target.dataset.pageId);
  if (from >= 0 && to >= 0 && from !== to) {
    const next = [...pages];
    const [moved] = next.splice(from, 1); next.splice(to, 0, moved);
    editPages(next, `Moved page ${from + 1} to position ${to + 1}.`, { id: moved.id });
  }
});
$('pages-grid').addEventListener('dragend', () => { draggedPageId = null; for (const card of $('pages-grid').children) card.classList.remove('dragging', 'drag-target'); });
$('clear-all').addEventListener('click', () => { showErrors([]); editPages([], 'Workspace cleared. Undo is available.'); });
$('undo-button').addEventListener('click', () => {
  if (busy || undoPages === null) return;
  pages = undoPages; undoPages = null;
  invalidateResult(); disposeUnusedSources(); render(); showErrors([]); announce('Last change undone.');
});
for (const id of ['image-size', 'image-margin']) $(id).addEventListener('change', () => { invalidateResult(); render(); announce('Image page settings updated. PDF pages keep their original size.'); });
$('compression').addEventListener('change', () => {
  invalidateResult(); render();
  announce($('compression').value === 'none' ? 'Original quality selected. No extra compression will be applied.' : `${compressionPresets[$('compression').value].label} selected. Compression is applied when you export.`);
});
$('filename').addEventListener('input', invalidateResult);
function safeFilename() {
  return ($('filename').value.trim().replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\.+$/g, '').slice(0, 160) || 'combined-document') + '.pdf';
}
$('export-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !pages.length) return;
  busy = 'export'; invalidateResult(); showErrors([]); render(); announce('Creating your combined PDF…');
  try {
    // Yield once so the progress state is visible before PDF processing begins.
    await new Promise(requestAnimationFrame);
    const filename = safeFilename();
    const active = activeSourceIds();
    let bytes = await assemblePdf([...sources.values()].filter((source) => active.has(source.id)), pages, { ...imageSettings(), title: filename.slice(0, -4) });
    const preset = $('compression').value;
    if (preset !== 'none') {
      if (!desktop?.compressPdf) throw new Error('Compression is available in the Mac desktop app.');
      busy = 'compress'; render(); announce('Compressing your PDF…');
      const originalBytes = bytes.length;
      const optimized = await optimizePdfLosslessly(bytes);
      const result = preset === 'aggressive'
        ? await optimizePdfAggressively(optimized.bytes, { renderForm: renderCompressionGraphic })
        : await desktop.compressPdf(optimized.bytes, preset);
      bytes = new Uint8Array(result.bytes);
      const saved = originalBytes - bytes.length;
      const percentage = Math.round(saved / originalBytes * 100);
      const reduction = `${percentage > 0 ? `${percentage}% smaller` : `${formatBytes(saved)} saved`} (${formatBytes(originalBytes)} → ${formatBytes(bytes.length)})`;
      const preserved = result.outcome === 'preserved-content';
      $('compression-result').textContent = saved > 0
        ? `${result.applied ? compressionPresets[preset].label : 'Lossless optimization'} · ${reduction}${preset === 'aggressive' ? '. Selectable text and links preserved.' : preserved ? '. Original text and graphics preserved.' : ''}`
        : preserved ? 'Original quality retained to preserve this PDF’s text and layout.' : 'No safe size reduction found. Original quality retained.';
      $('compression-result').hidden = false;
    }
    resultUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = $('download-again');
    link.href = resultUrl; link.download = filename;
    $('result-summary').textContent = `${filename} · ${pages.length} ${pageWord(pages.length)} · ${formatBytes(bytes.length)}`;
    $('result-panel').hidden = false;
    exportedPdf = { bytes, filename };
    if (desktop) {
      busy = 'save'; render();
      const saved = await desktop.savePdf(bytes, filename);
      announce(saved.saved ? `Saved ${saved.name}.` : 'Your PDF is ready. Choose Save again when you’re ready.', saved.saved);
    } else {
      link.click();
      announce('Your PDF is ready. If the download didn’t start, use Save again.', true);
    }
  } catch (error) {
    showErrors([error.message || 'The PDF could not be created. Try a smaller set of files.']);
    announce('Export didn’t finish. Your pages are still here.');
  } finally { busy = false; render(); }
});
$('download-again').addEventListener('click', async (event) => {
  if (!desktop) return;
  event.preventDefault();
  if (busy || !exportedPdf) return;
  busy = 'save'; render();
  try {
    const saved = await desktop.savePdf(exportedPdf.bytes, exportedPdf.filename);
    announce(saved.saved ? `Saved ${saved.name}.` : 'Save canceled. Your PDF is still ready.', saved.saved);
  } catch (error) { showErrors([error.message || 'The PDF could not be saved. Choose another folder.']); }
  finally { busy = false; render(); }
});
desktop?.onMenuAction((action) => {
  if (busy) return;
  if (action === 'open') chooseFiles();
  if (action === 'export' && pages.length) $('export-form').requestSubmit();
  if (action === 'undo') {
    const editingText = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if (editingText) document.execCommand('undo');
    else $('undo-button').click();
  }
});
let previewUrl = null;
async function openPreview(page, index) {
  const request = ++previewRequest;
  $('preview-title').textContent = `Page ${index + 1} · ${sources.get(page.sourceId).name}`;
  $('preview-image').removeAttribute('src');
  $('preview-image').hidden = true;
  $('preview-image').alt = `Preview of page ${index + 1}`;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  $('preview-dialog').showModal();
  try {
    const blob = await pageImage({ ...page }, 1600);
    if (request !== previewRequest || !$('preview-dialog').open) return;
    previewUrl = URL.createObjectURL(blob); $('preview-image').src = previewUrl; $('preview-image').hidden = false;
  } catch { if (request === previewRequest) $('preview-title').textContent = 'This page could not be previewed.'; }
}
$('preview-close').addEventListener('click', () => $('preview-dialog').close());
$('preview-dialog').addEventListener('click', (event) => { if (event.target === $('preview-dialog')) $('preview-dialog').close(); });
$('preview-dialog').addEventListener('close', () => { previewRequest++; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; $('preview-image').removeAttribute('src'); });
window.addEventListener('beforeunload', (event) => { if (!desktop && pages.length) { event.preventDefault(); event.returnValue = ''; } });
render();
