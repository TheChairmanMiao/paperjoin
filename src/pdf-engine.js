import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib';

const PAGE_SIZES = {
  a4: [595.2755905511812, 841.8897637795277],
  letter: [612, 792],
};

function requireBytes(bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error(`${label} is empty or cannot be read.`);
  }
  return bytes;
}

async function loadPdf(bytes) {
  requireBytes(bytes, 'The PDF');
  let document;
  try {
    // Deliberately use the default encryption check. Ignoring encryption can
    // produce an export whose page content is unreadable.
    document = await PDFDocument.load(bytes);
  } catch (error) {
    if (/encrypt/i.test(String(error?.message))) {
      throw new Error('Password-protected PDFs are not supported. Add an unlocked copy.');
    }
    throw new Error('This PDF could not be read. Try opening it and saving a new copy.');
  }
  if (document.isEncrypted) {
    throw new Error('Password-protected PDFs are not supported. Add an unlocked copy.');
  }
  if (document.getPageCount() === 0) {
    throw new Error('This PDF has no pages.');
  }
  return document;
}

function hasFormFields(document) {
  // Inspect the field tree directly: pdf-lib's getForm() removes XFA data.
  const form = document.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (form?.has(PDFName.of('XFA'))) return true;
  if ((form?.lookupMaybe(PDFName.of('Fields'), PDFArray)?.size() ?? 0) > 0) return true;
  // Some PDFs contain orphaned widgets outside the AcroForm field tree.
  // Copying such pages can also silently lose interactive field values.
  return document.getPages().some((page) => {
    const annotations = page.node.Annots();
    return annotations?.asArray().some((reference) => {
      const annotation = document.context.lookup(reference);
      return annotation instanceof PDFDict
        && annotation.get(PDFName.of('Subtype')) === PDFName.of('Widget');
    }) ?? false;
  });
}

function normalizedRotation(rotation = 0) {
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) {
    throw new Error('Page rotation must be a multiple of 90 degrees.');
  }
  return ((rotation % 360) + 360) % 360;
}

export async function inspectPdf(bytes) {
  const document = await loadPdf(bytes);
  return {
    pageCount: document.getPageCount(),
    dimensions: document.getPages().map((page) => ({
      width: page.getWidth(),
      height: page.getHeight(),
      rotation: page.getRotation().angle,
    })),
    hasFormFields: hasFormFields(document),
  };
}

/** Build a PDF without rasterizing existing PDF pages. */
export async function assemblePdf(sources, pages, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('Add a PDF or image before exporting.');
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('Keep at least one page to export.');
  }

  const imagePageSize = options.imagePageSize ?? 'original';
  const margin = options.imageMargin ?? 0;
  if (!['original', 'a4', 'letter'].includes(imagePageSize)) {
    throw new Error('Choose Original, A4, or Letter for image pages.');
  }
  if (!Number.isFinite(margin) || margin < 0) {
    throw new Error('Image margins must be zero or a positive number.');
  }
  if (options.title !== undefined && typeof options.title !== 'string') {
    throw new Error('The document title must be text.');
  }

  const sourceMap = new Map();
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !source.id.trim()) {
      throw new Error('A source document is missing its identifier.');
    }
    if (sourceMap.has(source.id)) {
      throw new Error('Source document identifiers must be unique.');
    }
    if (!['pdf', 'png', 'jpg'].includes(source.kind)) {
      throw new Error('Only PDF, PNG, and JPEG files are supported.');
    }
    requireBytes(source.bytes, 'A source file');
    sourceMap.set(source.id, source);
  }

  const output = await PDFDocument.create();
  output.setTitle(options.title?.trim() || 'Combined document');
  output.setCreator('PDF Combiner');
  output.setProducer('PDF Combiner');
  const requests = pages.map((selected) => {
    if (!selected || !sourceMap.has(selected.sourceId)) {
      throw new Error('A selected page no longer has its source file. Add the file again.');
    }
    const source = sourceMap.get(selected.sourceId);
    const rotation = normalizedRotation(selected.rotation);
    if (!Number.isInteger(selected.pageIndex) || selected.pageIndex < 0) {
      throw new Error('A selected page has an invalid page number.');
    }
    if (source.kind !== 'pdf' && selected.pageIndex !== 0) {
      throw new Error('An image has only one page.');
    }
    return { source, pageIndex: selected.pageIndex, rotation };
  });

  // A single copyPages call per source shares its copied fonts, images, and
  // content streams across pages. Calling it per page duplicates those objects.
  const pdfGroups = new Map();
  requests.forEach((request, position) => {
    if (request.source.kind !== 'pdf') return;
    if (!pdfGroups.has(request.source.id)) pdfGroups.set(request.source.id, []);
    pdfGroups.get(request.source.id).push({ ...request, position });
  });
  const copiedPdfPages = new Map();
  for (const group of pdfGroups.values()) {
    const document = await loadPdf(group[0].source.bytes);
    if (hasFormFields(document)) {
      throw new Error('This PDF contains form fields. Add a flattened copy to preserve filled values.');
    }
    for (const request of group) {
      if (request.pageIndex >= document.getPageCount()) {
        throw new Error('A selected page is outside its source PDF.');
      }
    }
    const copied = await output.copyPages(document, group.map((request) => request.pageIndex));
    group.forEach((request, index) => {
      copied[index].setRotation(degrees(normalizedRotation(copied[index].getRotation().angle + request.rotation)));
      copiedPdfPages.set(request.position, copied[index]);
    });
  }

  const loadedImages = new Map();
  for (let position = 0; position < requests.length; position += 1) {
    const { source, rotation } = requests[position];
    if (source.kind === 'pdf') {
      output.addPage(copiedPdfPages.get(position));
      continue;
    }
    if (!loadedImages.has(source.id)) {
      try {
        loadedImages.set(source.id, source.kind === 'png'
          ? await output.embedPng(source.bytes)
          : await output.embedJpg(source.bytes));
      } catch {
        throw new Error('This image could not be read. Add a valid PNG or JPEG file.');
      }
    }
    const image = loadedImages.get(source.id);
    const [width, height] = imagePageSize === 'original'
      ? [image.width * 0.75 + margin * 2, image.height * 0.75 + margin * 2]
      : PAGE_SIZES[imagePageSize];
    if (margin * 2 >= width || margin * 2 >= height) {
      throw new Error('Image margins leave no room on the page. Choose a smaller margin.');
    }
    const scale = Math.min((width - margin * 2) / image.width, (height - margin * 2) / image.height);
    const drawnWidth = image.width * scale;
    const drawnHeight = image.height * scale;
    const page = output.addPage([width, height]);
    page.drawImage(image, {
      x: (width - drawnWidth) / 2,
      y: (height - drawnHeight) / 2,
      width: drawnWidth,
      height: drawnHeight,
    });
    page.setRotation(degrees(rotation));
  }

  return output.save();
}
