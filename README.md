# Paperjoin

A personal Mac app for combining PDFs, PNGs, and JPEGs into a single PDF. Files are processed locally; all libraries are bundled, and the desktop app blocks outbound web requests. No server or account is needed.

## Use

After building with `npm run package:mac` (see Development below), open `output/desktop/1.1.0/Paperjoin-darwin-arm64/Paperjoin.app`. You can copy the app to your Applications folder if you want to keep it there.

1. Choose **Add files** or press **⌘O**. You can also drop files into the workspace.
2. Drag pages into order, or use their arrow buttons. Click a thumbnail for a larger preview. Rotate or remove pages as needed; **Undo** reverses the last page change.
3. Name the document and choose Original quality, High quality, Balanced, or Smallest file compression. For image pages, choose Original, A4, or US Letter and optional margins.
4. Choose **Export PDF** or press **⌘S**, then pick a save location in the Mac save dialog.

The original files are unchanged. The workspace is temporary and clears when the app closes. Closing a populated workspace asks before discarding the page arrangement. The app does not save a workspace or reopen previous files.

## Compression

- **Original quality** (default): no additional image compression.
- **High quality**: light JPEG compression with images capped at 300 dpi; intended for print and detailed images.
- **Balanced**: JPEG compression with images capped at 150 dpi; intended for everyday sharing.
- **Smallest file**: stronger JPEG compression with images capped at 96 dpi; images may look softer.

Compression applies to images already inside PDFs as well as image files you add. Existing text and vector content are retained; pages are not turned into pictures. Results show the actual size reduction compared with the assembled PDF before compression. A compressed version is used only when it is smaller; otherwise the original quality is retained. Savings vary with the input, especially for text-only or previously optimized PDFs.

A bundled native helper uses macOS PDFKit and Quartz image filters. It runs locally without installing an additional tool. Temporary files are removed when processing finishes, and failed compression leaves the workspace intact.

## Supported files and limits

- PDF, PNG, and JPEG.
- Up to 50 MB per file, 150 MB in the workspace, and 500 pages; individual images are limited to 40 megapixels. Large image-heavy documents may still use substantial memory.
- Password-protected PDFs and PDFs with interactive form fields are rejected. Add an unlocked or flattened copy instead.
- Existing PDF page dimensions, crop boxes, text, vector content, and page rotations are retained. Document-level bookmarks, attachments, PDF/A conformance, accessibility structure, and digital signatures are not preserved by merging.
- Original image size uses 96 pixels per inch. A4/Letter fit and center images. Margins apply only to images. JPEG camera orientation is normalized before export.
- Export saves a new document. It does not provide OCR, Word import, target-file-size compression, or PDF content editing.

## Development

Requires Node.js 22.13+, npm, and Xcode Command Line Tools to compile the small native compression helper. The packaged app does not require those tools. This build targets Apple silicon Macs.

```sh
npm ci
npm test
npm start
npm run package:mac
```

`npm start` builds and opens the desktop app. `npm run package:mac` creates the `.app` and applies an ad-hoc local signature. The personal build is not Apple notarized and is intended for this Mac; distributing it to other people requires Developer ID signing and notarization.

The renderer has no direct Node.js access. A narrow isolated bridge provides native Open/Save dialogs and menu actions. PDF previews and assembly run in the renderer, and arbitrary navigation and external network requests are blocked.

Libraries: [PDF-LIB](https://pdf-lib.js.org/), [PDF.js](https://mozilla.github.io/pdf.js/), and [Electron](https://www.electronjs.org/). Their licenses are included with the application.
