import Foundation
import PDFKit
import Quartz
import Darwin

struct CompressionPreset {
    let resolution: Int
    let quality: Double
}

enum CompressionError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

func normalizedText(_ text: String?) -> String {
    (text ?? "").precomposedStringWithCanonicalMapping
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }.joined(separator: " ")
}

func sameRect(_ left: CGRect, _ right: CGRect) -> Bool {
    zip([left.minX, left.minY, left.width, left.height],
        [right.minX, right.minY, right.width, right.height])
        .allSatisfy { abs($0 - $1) < 0.01 }
}

func verify(_ candidate: PDFDocument, against original: PDFDocument) throws {
    guard candidate.pageCount == original.pageCount else {
        throw CompressionError.invalid("Compression changed the number of pages.")
    }
    for index in 0..<original.pageCount {
        guard let before = original.page(at: index), let after = candidate.page(at: index),
              let beforeRef = before.pageRef, let afterRef = after.pageRef,
              sameRect(beforeRef.getBoxRect(.mediaBox), afterRef.getBoxRect(.mediaBox)),
              sameRect(beforeRef.getBoxRect(.cropBox), afterRef.getBoxRect(.cropBox)),
              ((beforeRef.rotationAngle % 360) + 360) % 360 == ((afterRef.rotationAngle % 360) + 360) % 360 else {
            throw CompressionError.invalid("Compression changed a page's size or rotation.")
        }
        let beforeText = normalizedText(before.string)
        if !beforeText.isEmpty && beforeText != normalizedText(after.string) {
            throw CompressionError.invalid("Compression could not preserve the document's searchable text.")
        }
    }
}

func run() throws {
    guard CommandLine.arguments.count == 4 else {
        throw CompressionError.invalid("Usage: paperjoin-compress input.pdf output.pdf high|balanced|small")
    }
    let presets = [
        "high": CompressionPreset(resolution: 300, quality: 0.9),
        "balanced": CompressionPreset(resolution: 150, quality: 0.75),
        "small": CompressionPreset(resolution: 96, quality: 0.5),
    ]
    let presetName = CommandLine.arguments[3]
    guard let preset = presets[presetName] else {
        throw CompressionError.invalid("Choose high, balanced, or small compression.")
    }
    let input = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    let output = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
    guard input.resolvingSymlinksInPath() != output.resolvingSymlinksInPath() else {
        throw CompressionError.invalid("Compression needs a separate output file.")
    }
    let originalBytes = try Data(contentsOf: input, options: .mappedIfSafe)
    guard let original = PDFDocument(data: originalBytes), original.pageCount > 0, !original.isEncrypted else {
        throw CompressionError.invalid("The PDF is unreadable, empty, or password-protected.")
    }
    let properties: [String: Any] = [
        "Name": "Paperjoin \(presetName)",
        "FilterType": 1,
        "Domains": ["Applications": true, "Printing": true],
        "FilterData": ["ColorSettings": ["ImageSettings": [
            "Compression Quality": preset.quality,
            "ImageCompression": "ImageJPEGCompress",
            "ImageScaleSettings": [
                "ImageResolution": preset.resolution,
                "ImageScaleInterpolate": true,
                "ImageSizeMax": 20000,
                "ImageSizeMin": 0,
            ],
        ]]],
    ]
    guard let filter = QuartzFilter(properties: properties) else {
        throw CompressionError.invalid("The Mac PDF compression filter could not be created.")
    }
    let temporary = output.deletingLastPathComponent()
        .appendingPathComponent(".paperjoin-compress-\(UUID().uuidString).pdf")
    defer { try? FileManager.default.removeItem(at: temporary) }
    let options: [PDFDocumentWriteOption: Any] = [PDFDocumentWriteOption(rawValue: "QuartzFilter"): filter]
    guard original.write(to: temporary, withOptions: options),
          let candidate = PDFDocument(url: temporary) else {
        throw CompressionError.invalid("The PDF could not be compressed on this Mac.")
    }
    try verify(candidate, against: original)
    let candidateBytes = try Data(contentsOf: temporary, options: .mappedIfSafe)
    let applied = candidateBytes.count < originalBytes.count
    let finalBytes = applied ? candidateBytes : originalBytes
    try finalBytes.write(to: output, options: .atomic)
    let result: [String: Any] = [
        "originalBytes": originalBytes.count,
        "outputBytes": finalBytes.count,
        "applied": applied,
        "preset": presetName,
    ]
    let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data([10]))
}

do { try autoreleasepool { try run() } }
catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
