import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES = 128 * 1024 * 1024;
const name = (value) => PDFName.of(value);
const equalBytes = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

async function readBounded(readable, limit, budget) {
  const reader = readable.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (budget) budget.decoded += value.length;
      if (length > limit || (budget && budget.decoded > MAX_TOTAL_DECODED_BYTES)) {
        throw new Error('Stream exceeds the optimization budget.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function transform(bytes, transformer, limit, budget) {
  return readBounded(new Blob([bytes]).stream().pipeThrough(transformer), limit, budget);
}

function canonical(object) {
  if (object instanceof PDFDict) {
    return object.entries().map(([key, value]) => [key.toString(), canonical(value)])
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }
  if (object instanceof PDFArray) return object.asArray().map(canonical);
  return object.toString();
}

function streamDictionaryKey(stream) {
  return JSON.stringify(stream.dict.entries().filter(([key]) => key !== name('Length'))
    .map(([key, value]) => [key.toString(), canonical(value)])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function walkDirect(object, visitReference, seen) {
  if (!object || seen.has(object)) return;
  seen.add(object);
  if (object instanceof PDFRawStream) { walkDirect(object.dict, visitReference, seen); return; }
  if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) {
      if (value instanceof PDFRef) object.set(key, visitReference(value));
      else walkDirect(value, visitReference, seen);
    }
  } else if (object instanceof PDFArray) {
    for (let index = 0; index < object.size(); index += 1) {
      const value = object.get(index);
      if (value instanceof PDFRef) object.set(index, visitReference(value));
      else walkDirect(value, visitReference, seen);
    }
  }
}

async function deduplicateFontPrograms(document) {
  if (!globalThis.crypto?.subtle) return 0;
  const fontRefs = new Map();
  const visited = new WeakSet();
  function collect(object) {
    if (!object || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFRawStream) { collect(object.dict); return; }
    if (object instanceof PDFDict) {
      for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
        const ref = object.get(name(key));
        if (ref instanceof PDFRef && document.context.lookup(ref) instanceof PDFRawStream) fontRefs.set(ref.toString(), ref);
      }
      for (const [, value] of object.entries()) if (!(value instanceof PDFRef)) collect(value);
    } else if (object instanceof PDFArray) for (const value of object.asArray()) if (!(value instanceof PDFRef)) collect(value);
  }
  for (const [, object] of document.context.enumerateIndirectObjects()) collect(object);
  const buckets = new Map();
  const replacements = new Map();
  for (const ref of fontRefs.values()) {
    const stream = document.context.lookup(ref);
    if (stream.contents.length > MAX_STREAM_BYTES || stream.dict.has(name('F'))) continue;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', stream.contents));
    const key = `${streamDictionaryKey(stream)}:${Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('')}`;
    const prior = buckets.get(key);
    if (prior && equalBytes(prior.stream.contents, stream.contents)) replacements.set(ref.toString(), prior.ref);
    else buckets.set(key, { ref, stream });
  }
  if (!replacements.size) return 0;
  const seen = new WeakSet();
  const replace = (ref) => replacements.get(ref.toString()) ?? ref;
  for (const [, object] of document.context.enumerateIndirectObjects()) walkDirect(object, replace, seen);
  for (const [key, ref] of Object.entries(document.context.trailerInfo)) {
    if (ref instanceof PDFRef) document.context.trailerInfo[key] = replace(ref);
  }
  // All indirect objects are serialized, even when no longer referenced.
  for (const key of replacements.keys()) document.context.delete(fontRefs.get(key));
  return replacements.size;
}

/** Repack stream bytes without changing PDF drawing commands, fonts, or images. */
export async function optimizePdfLosslessly(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('The PDF is empty or cannot be read.');
  let document;
  try { document = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (error) {
    if (/encrypt/i.test(String(error?.message))) throw new Error('Password-protected PDFs are not supported. Add an unlocked copy.');
    throw new Error('This PDF could not be read. Try opening it and saving a new copy.');
  }
  if (document.isEncrypted) throw new Error('Password-protected PDFs are not supported. Add an unlocked copy.');
  if (!document.getPageCount()) throw new Error('This PDF has no pages.');
  const stats = { streamsRecompressed: 0, duplicateFontPrograms: 0 };
  const budget = { decoded: 0 };
  if (globalThis.CompressionStream && globalThis.DecompressionStream) {
    for (const [ref, stream] of document.context.enumerateIndirectObjects()) {
      if (!(stream instanceof PDFRawStream) || stream.dict.has(name('DecodeParms')) || stream.dict.has(name('F'))) continue;
      const filter = stream.dict.get(name('Filter'));
      if (filter && filter !== name('FlateDecode')) continue;
      if (budget.decoded >= MAX_TOTAL_DECODED_BYTES) break;
      try {
        let decoded;
        if (filter) decoded = await transform(stream.contents, new DecompressionStream('deflate'), MAX_STREAM_BYTES, budget);
        else {
          if (stream.contents.length > MAX_STREAM_BYTES || budget.decoded + stream.contents.length > MAX_TOTAL_DECODED_BYTES) continue;
          decoded = stream.contents;
          budget.decoded += decoded.length;
        }
        const encoded = await transform(decoded, new CompressionStream('deflate'), Math.min(MAX_STREAM_BYTES, stream.contents.length + 64));
        const dictionary = stream.dict.clone(document.context);
        dictionary.set(name('Filter'), name('FlateDecode'));
        dictionary.set(name('Length'), PDFNumber.of(encoded.length));
        const candidate = PDFRawStream.of(dictionary, encoded);
        if (candidate.sizeInBytes() >= stream.sizeInBytes()) continue;
        const verified = await transform(encoded, new DecompressionStream('deflate'), MAX_STREAM_BYTES, budget);
        if (!equalBytes(decoded, verified)) continue;
        document.context.assign(ref, candidate);
        stats.streamsRecompressed += 1;
      } catch {
        // Unsupported, corrupt, or oversized stream data stays untouched.
      }
    }
  }
  stats.duplicateFontPrograms = await deduplicateFontPrograms(document);
  const candidate = await document.save({ addDefaultPage: false, useObjectStreams: true, updateFieldAppearances: false });
  const applied = candidate.length < bytes.length;
  return {
    bytes: applied ? candidate : bytes,
    originalBytes: bytes.length,
    outputBytes: applied ? candidate.length : bytes.length,
    applied,
    stats: applied ? stats : { streamsRecompressed: 0, duplicateFontPrograms: 0 },
  };
}
