import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFRawStream, PDFRef } from 'pdf-lib';

const key = (value) => PDFName.of(value);
const MIN_FORM_BYTES = 128 * 1024;
const MAX_FORM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FORMS = 24;
const MAX_PIXELS = 16_000_000;
const identity = [1, 0, 0, 1, 0, 0];
const allowedOperators = new Set(['q', 'Q', 'cm', 'm', 'l', 'c', 'v', 'y', 'h', 're', 'f', 'F', 'f*', 'n', 'W', 'W*', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k', 'Do']);
const lookup = (context, object) => object instanceof PDFRef ? context.lookup(object) : object;

function numbers(context, object, count) {
  const array = lookup(context, object);
  if (!(array instanceof PDFArray) || array.size() !== count) return null;
  const values = array.asArray().map((value) => lookup(context, value));
  return values.every((value) => value instanceof PDFNumber && Number.isFinite(value.asNumber())) ? values.map((value) => value.asNumber()) : null;
}

// Tokenize operators separately from literal/hex strings and composite operands.
// A string containing "Do" or "cs" must never be mistaken for a graphics state.
function contentTokens(bytes) {
  const text = new TextDecoder('latin1').decode(bytes), tokens = [];
  const white = (char) => !char || /[\0\t\n\f\r ]/.test(char);
  const delimiter = (char) => white(char) || '()<>[]{}/%'.includes(char);
  let index = 0;
  function skipString() {
    let nesting = 1; index += 1;
    while (index < text.length && nesting) {
      const char = text[index++];
      if (char === '\\') index += 1;
      else if (char === '(') nesting += 1;
      else if (char === ')') nesting -= 1;
    }
    return nesting === 0;
  }
  function skipComposite(close) {
    while (index < text.length) {
      if (text.startsWith(close, index)) { index += close.length; return true; }
      const char = text[index];
      if (char === '(') { if (!skipString()) return false; }
      else if (char === '%') { while (index < text.length && !/[\r\n]/.test(text[index])) index += 1; }
      else if (char === '[') { index += 1; if (!skipComposite(']')) return false; }
      else if (text.startsWith('<<', index)) { index += 2; if (!skipComposite('>>')) return false; }
      else if (char === '<') { const end = text.indexOf('>', index + 1); if (end < 0) return false; index = end + 1; }
      else index += 1;
    }
    return false;
  }
  while (index < text.length) {
    const char = text[index];
    if (white(char)) { index += 1; continue; }
    if (char === '%') { while (index < text.length && !/[\r\n]/.test(text[index])) index += 1; continue; }
    if (char === '(') { if (!skipString()) return null; tokens.push('@operand'); continue; }
    if (char === '[' || text.startsWith('<<', index)) {
      const close = char === '[' ? ']' : '>>'; index += close.length;
      if (!skipComposite(close)) return null; tokens.push('@operand'); continue;
    }
    if (char === '<') { const end = text.indexOf('>', index + 1); if (end < 0) return null; index = end + 1; tokens.push('@operand'); continue; }
    const start = index++;
    while (index < text.length && !delimiter(text[index])) index += 1;
    const token = text.slice(start, index);
    if (token === '/' || ['}', ']', '>'].includes(token)) return null;
    tokens.push(token);
    if (tokens.length > 1_000_000) return null;
  }
  return tokens;
}

function graphicsOnlyContent(bytes) {
  const tokens = contentTokens(bytes);
  if (!tokens) return false;
  let fillColor = false;
  const stack = [];
  let operands = [];
  for (const token of tokens) {
    if (token.startsWith('/') || /^[+-]?(?:\d+\.\d*|\.\d+|\d+)$/.test(token)) { operands.push(token); continue; }
    if (!allowedOperators.has(token)) return false;
    if (token === 'q') stack.push(fillColor);
    if (token === 'Q') { if (!stack.length) return false; fillColor = stack.pop(); }
    if (['g', 'rg', 'k', 'sc', 'scn'].includes(token)) fillColor = true;
    if (['f', 'F', 'f*'].includes(token) && !fillColor) return false;
    if (['Do', 'gs', 'CS', 'cs'].includes(token) && (operands.length !== 1 || !operands[0].startsWith('/'))) return false;
    operands = [];
  }
  return stack.length === 0 && operands.length === 0;
}

function safeGroup(context, object) {
  const group = lookup(context, object);
  if (!group) return true;
  if (!(group instanceof PDFDict) || group.get(key('S')) !== key('Transparency') || group.has(key('CS'))) return false;
  if (lookup(context, group.get(key('K'))) === PDFBool.True) return false;
  return group.keys().every((name) => ['Type', 'S', 'I', 'K', 'CS'].some((value) => name === key(value)));
}

async function decodedForm(form, state) {
  if (!form.dict.get(key('Filter'))) {
    state.decoded += form.contents.length;
    if (form.contents.length > MAX_FORM_BYTES || state.decoded > MAX_TOTAL_BYTES) return null;
    return form.contents;
  }
  if (!globalThis.DecompressionStream) return null;
  const reader = new Blob([form.contents]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length; state.decoded += value.length;
      if (length > MAX_FORM_BYTES || state.decoded > MAX_TOTAL_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } catch { await reader.cancel().catch(() => {}); return null; }
  finally { reader.releaseLock(); }
}

async function eligibleForm(context, form, state, depth = 0) {
  if (!(form instanceof PDFRawStream) || form.dict.get(key('Subtype')) !== key('Form') || depth > 8) return false;
  if (state.active.has(form)) return false;
  if (state.verified.has(form)) return true;
  if (form.dict.has(key('F')) || form.dict.has(key('DecodeParms')) || !safeGroup(context, form.dict.get(key('Group')))) return false;
  const filter = form.dict.get(key('Filter'));
  if (filter && filter !== key('FlateDecode')) return false;
  const matrix = form.dict.get(key('Matrix'));
  if (matrix && numbers(context, matrix, 6)?.some((value, index) => value !== identity[index])) return false;
  if (matrix && !numbers(context, matrix, 6)) return false;
  const allowedKeys = ['Type', 'Subtype', 'FormType', 'BBox', 'Matrix', 'Resources', 'Group', 'Length', 'Filter'];
  if (form.dict.keys().some((name) => !allowedKeys.some((value) => name === key(value)))) return false;
  const decoded = await decodedForm(form, state);
  if (!decoded || !graphicsOnlyContent(decoded)) return false;
  const resources = lookup(context, form.dict.get(key('Resources')));
  if (!(resources instanceof PDFDict)) return false;
  if (resources.keys().some((name) => !['XObject', 'ExtGState', 'ColorSpace', 'ProcSet'].some((value) => name === key(value)))) return false;
  state.active.add(form);
  try {
    const nested = lookup(context, resources.get(key('XObject')));
    if (nested && !(nested instanceof PDFDict)) return false;
    if (nested) for (const [, ref] of nested.entries()) if (!await eligibleForm(context, lookup(context, ref), state, depth + 1)) return false;
    const settings = lookup(context, resources.get(key('ExtGState')));
    if (settings && !(settings instanceof PDFDict)) return false;
    if (settings) for (const [, ref] of settings.entries()) {
      const setting = lookup(context, ref);
      if (!(setting instanceof PDFDict) || setting.keys().some((name) => !['Type', 'ca', 'CA', 'SMask', 'BM'].some((value) => name === key(value)))) return false;
      const blend = lookup(context, setting.get(key('BM')));
      if (blend && blend !== key('Normal') && blend !== key('Compatible')) return false;
      const mask = lookup(context, setting.get(key('SMask')));
      if (mask && mask !== key('None')) {
        if (!(mask instanceof PDFDict) || mask.get(key('S')) !== key('Alpha') || mask.keys().some((name) => !['Type', 'S', 'G'].some((value) => name === key(value)))) return false;
        if (!await eligibleForm(context, lookup(context, mask.get(key('G'))), state, depth + 1)) return false;
      }
    }
    state.verified.add(form);
    return true;
  } finally { state.active.delete(form); }
}

function resolvedColorSpace(context, resources, operand, seen = new Set()) {
  const colorSpaces = lookup(context, resources?.get(key('ColorSpace')));
  let object = operand instanceof PDFName ? operand : key(operand.slice(1).replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
  if (seen.has(object)) return null;
  seen.add(object);
  const defaults = new Map([[key('DeviceGray'), key('DefaultGray')], [key('DeviceRGB'), key('DefaultRGB')], [key('DeviceCMYK'), key('DefaultCMYK')]]);
  if (defaults.has(object)) return lookup(context, colorSpaces?.get(defaults.get(object))) ?? object;
  object = lookup(context, colorSpaces?.get(object));
  if (object instanceof PDFName) return resolvedColorSpace(context, resources, object, seen);
  if (object instanceof PDFArray && [key('CalGray'), key('CalRGB'), key('Lab'), key('ICCBased'), key('Indexed'), key('Separation'), key('DeviceN')].includes(object.get(0))) return object;
  return null;
}

function defaultCallerSetting(context, setting) {
  if (!(setting instanceof PDFDict)) return { unsafe: true };
  let needsGroup = false;
  for (const [name, raw] of setting.entries()) {
    const value = lookup(context, raw);
    if (name === key('Type')) continue;
    if (name === key('ca') || name === key('CA')) { if (!(value instanceof PDFNumber) || value.asNumber() !== 1) return { unsafe: true }; }
    else if (name === key('BM')) { if (value !== key('Normal') && value !== key('Compatible')) return { unsafe: true }; }
    else if (name === key('SMask')) {
      if (value === key('None')) continue;
      if (!(value instanceof PDFDict) || value.get(key('S')) !== key('Alpha')) return { unsafe: true };
      needsGroup = true;
    } else return { unsafe: true };
  }
  return { unsafe: false, needsGroup };
}

async function inheritedFillSpaces(document, budget) {
  const context = document.context, calls = new Map(), active = new Set();
  let visits = 0;
  async function walk(contents, resources, initial, depth) {
    if (!contents) return;
    if (depth > 8 || visits++ > 128) throw new Error('Graphics context exceeds the optimization budget.');
    let state = { ...initial }, operands = [];
    const stack = [];
    const parts = contents instanceof PDFArray ? contents.asArray() : [contents];
    for (const part of parts) {
      const stream = lookup(context, part);
      if (!(stream instanceof PDFRawStream)) throw new Error('Unknown PDF content stream.');
      const filter = stream.dict.get(key('Filter'));
      if (stream.dict.has(key('DecodeParms')) || stream.dict.has(key('F')) || (filter && filter !== key('FlateDecode'))) throw new Error('Unknown PDF content filter.');
      const data = await decodedForm(stream, budget), tokens = data && contentTokens(data);
      if (!tokens) throw new Error('Unknown PDF content syntax.');
      for (const token of tokens) {
        if (token === 'BI') throw new Error('Inline image contexts are not supported.');
        if (token === '@operand' || token.startsWith('/') || /^[+-]?(?:\d+\.\d*|\.\d+|\d+)$/.test(token)) { operands.push(token); continue; }
        if (token === 'q') stack.push({ ...state });
        else if (token === 'Q') { if (!stack.length) throw new Error('Unbalanced PDF graphics state.'); state = stack.pop(); }
        else if (token === 'cs') state.space = operands.length === 1 && operands[0].startsWith('/') ? resolvedColorSpace(context, resources, operands[0]) : null;
        else if (['g', 'rg', 'k'].includes(token)) state.space = resolvedColorSpace(context, resources, key({ g: 'DeviceGray', rg: 'DeviceRGB', k: 'DeviceCMYK' }[token]));
        else if (token === 'ri') state.unsafe = true;
        else if (token === 'gs') {
          const settings = lookup(context, resources?.get(key('ExtGState')));
          const setting = operands.length === 1 && operands[0].startsWith('/') && settings instanceof PDFDict ? lookup(context, settings.get(key(operands[0].slice(1).replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))))) : null;
          const inherited = defaultCallerSetting(context, setting);
          state.unsafe ||= inherited.unsafe; state.needsGroup ||= inherited.needsGroup;
        } else if (token === 'Do') {
          const objects = lookup(context, resources?.get(key('XObject')));
          const ref = operands.length === 1 && operands[0].startsWith('/') && objects instanceof PDFDict ? objects.get(key(operands[0].slice(1).replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))))) : null;
          const form = lookup(context, ref);
          if (form instanceof PDFRawStream && form.dict.get(key('Subtype')) === key('Form')) {
            const refKey = ref instanceof PDFRef ? ref.toString() : null;
            const group = lookup(context, form.dict.get(key('Group')));
            const space = !state.unsafe && (!state.needsGroup || group instanceof PDFDict && group.get(key('S')) === key('Transparency')) ? state.space : null;
            if (refKey) {
              if (!calls.has(refKey)) calls.set(refKey, space);
              else if (!space || calls.get(refKey)?.toString() !== space.toString()) calls.set(refKey, null);
            }
            if (active.has(form)) throw new Error('Cyclic PDF graphics state.');
            active.add(form);
            try { await walk(form, lookup(context, form.dict.get(key('Resources'))) ?? resources, state, depth + 1); }
            finally { active.delete(form); }
          }
        }
        operands = [];
      }
    }
    if (stack.length) throw new Error('Unbalanced PDF graphics state.');
  }
  try {
    for (const page of document.getPages()) {
      const resources = page.node.Resources();
      await walk(page.node.Contents(), resources, { space: resolvedColorSpace(context, resources, key('DeviceGray')), unsafe: false, needsGroup: false }, 0);
    }
    return calls;
  } catch { return new Map(); }
}

function nonPageFormReferences(document) {
  const blocked = new Set(), visited = new WeakSet();
  function mark(object, references = new Set()) {
    if (object instanceof PDFRef) {
      const ref = object.toString();
      if (references.has(ref)) return;
      references.add(ref); blocked.add(ref); mark(document.context.lookup(object), references);
    } else if (object instanceof PDFRawStream) mark(object.dict, references);
    else if (object instanceof PDFDict) for (const [, value] of object.entries()) mark(value, references);
    else if (object instanceof PDFArray) for (const value of object.asArray()) mark(value, references);
  }
  function find(object) {
    if (!object || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFRawStream) find(object.dict);
    else if (object instanceof PDFDict) {
      if (object.get(key('Subtype')) === key('Type3')) mark(object);
      for (const [name, value] of object.entries()) {
      if ([key('AP'), key('G'), key('Pattern')].includes(name)) mark(value);
      if (!(value instanceof PDFRef)) find(value);
      }
    } else if (object instanceof PDFArray) for (const value of object.asArray()) if (!(value instanceof PDFRef)) find(value);
  }
  for (const [, object] of document.context.enumerateIndirectObjects()) find(object);
  return blocked;
}

async function isolatedForm(document, form, box, fillSpace) {
  const wrapper = await PDFDocument.create();
  const copied = PDFObjectCopier.for(document.context, wrapper.context).copy(form);
  const ref = wrapper.context.register(copied);
  const [x, y, right, top] = box;
  const page = wrapper.addPage([right - x, top - y]);
  const copiedSpace = PDFObjectCopier.for(document.context, wrapper.context).copy(fillSpace);
  page.node.set(key('Resources'), wrapper.context.obj({ XObject: { RasterSource: ref }, ColorSpace: { InheritedFill: copiedSpace } }));
  page.node.set(key('Contents'), wrapper.context.register(wrapper.context.flateStream(`q /InheritedFill cs 1 0 0 1 ${-x} ${-y} cm /RasterSource Do Q`)));
  return wrapper.save({ updateFieldAppearances: false });
}

/** Rasterize only proven graphics-only forms, leaving page text and links intact. */
export async function optimizePdfAggressively(bytes, { renderForm } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('The PDF is empty or cannot be read.');
  if (typeof renderForm !== 'function') throw new Error('Graphics compression is unavailable in this app build.');
  let document;
  try { document = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch { throw new Error('This PDF could not be read for graphics compression.'); }
  if (document.isEncrypted || !document.getPageCount()) throw new Error('The PDF is encrypted or has no pages.');
  const state = { active: new WeakSet(), verified: new WeakSet(), decoded: 0 };
  const callSpaces = await inheritedFillSpaces(document, state);
  const excluded = nonPageFormReferences(document);
  let rasterizedForms = 0;
  for (const [ref, form] of document.context.enumerateIndirectObjects()) {
    if (rasterizedForms >= MAX_FORMS || state.decoded > MAX_TOTAL_BYTES) break;
    if (!(form instanceof PDFRawStream) || form.contents.length < MIN_FORM_BYTES || form.contents.length > MAX_FORM_BYTES) continue;
    const fillSpace = callSpaces.get(ref.toString());
    if (!fillSpace || excluded.has(ref.toString())) continue;
    const box = numbers(document.context, form.dict.get(key('BBox')), 4);
    if (!box) continue;
    const width = box[2] - box[0], height = box[3] - box[1];
    if (width <= 0 || height <= 0 || width * height * 4 > MAX_PIXELS || !await eligibleForm(document.context, form, state)) continue;
    try {
      const png = await renderForm(await isolatedForm(document, form, box, fillSpace), { width, height });
      if (!(png instanceof Uint8Array) || png.length < 8 || png.length >= form.contents.length) continue;
      const before = new Set(document.context.enumerateIndirectObjects().map(([objectRef]) => objectRef.toString()));
      const image = await document.embedPng(png);
      await image.embed();
      const added = document.context.enumerateIndirectObjects().filter(([objectRef]) => !before.has(objectRef.toString()));
      const content = `q ${width} 0 0 ${height} ${box[0]} ${box[1]} cm /RasterImage Do Q`;
      const dictionary = form.dict.clone(document.context);
      dictionary.delete(key('Length')); dictionary.delete(key('Filter'));
      const resources = lookup(document.context, form.dict.get(key('Resources'))).clone(document.context);
      resources.set(key('XObject'), document.context.obj({ RasterImage: image.ref }));
      dictionary.set(key('Resources'), resources);
      const candidate = document.context.flateStream(content, Object.fromEntries(dictionary.entries().map(([name, value]) => [name.decodeText(), value])));
      if (added.reduce((total, [, object]) => total + object.sizeInBytes(), candidate.sizeInBytes()) >= form.sizeInBytes()) {
        for (const [objectRef] of added) document.context.delete(objectRef);
        continue;
      }
      document.context.assign(ref, candidate);
      rasterizedForms += 1;
    } catch {
      // A form that cannot be safely rendered is left in its original form.
    }
  }
  const candidate = rasterizedForms ? await document.save({ addDefaultPage: false, updateFieldAppearances: false, useObjectStreams: true }) : bytes;
  const applied = candidate.length < bytes.length;
  return { bytes: applied ? candidate : bytes, originalBytes: bytes.length, outputBytes: applied ? candidate.length : bytes.length, applied, outcome: applied ? 'aggressive' : 'already-compact', stats: { rasterizedForms: applied ? rasterizedForms : 0 } };
}
