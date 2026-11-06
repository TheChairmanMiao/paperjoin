const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, writeFile, stat, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runFile = promisify(execFile);
const PRESETS = new Set(['none', 'high', 'balanced', 'small']);
const MAX_BYTES = 300 * 1024 * 1024;

async function compressPdf(bytes, preset, helperPath) {
  if (!PRESETS.has(preset)) throw new Error('Choose one of the available compression options.');
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > MAX_BYTES || Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') {
    throw new Error('The PDF could not be read for compression. Create it again.');
  }
  if (preset === 'none') return { bytes, originalBytes: bytes.length, outputBytes: bytes.length, applied: false };
  let directory;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'paperjoin-compress-'));
    const input = path.join(directory, 'input.pdf');
    const output = path.join(directory, 'output.pdf');
    await writeFile(input, bytes, { mode: 0o600 });
    await runFile(helperPath, [input, output, preset], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024, windowsHide: true });
    const info = await stat(output);
    if (!info.isFile() || info.size < 5 || info.size > MAX_BYTES) throw new Error('Invalid compression output.');
    const compressed = await readFile(output);
    if (compressed.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid compression output.');
    // A rewrite can grow a compact PDF. Keep its existing quality when there is no size benefit.
    const applied = compressed.length < bytes.length;
    const result = applied ? compressed : bytes;
    return { bytes: result, originalBytes: bytes.length, outputBytes: result.length, applied };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Compression is unavailable in this app build. Choose Original quality or rebuild the app.');
    if (error.killed) throw new Error('Compression took too long. Try a smaller document or choose Original quality.');
    throw new Error('Compression could not finish. Try Original quality or a smaller document.');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
module.exports = { compressPdf };
