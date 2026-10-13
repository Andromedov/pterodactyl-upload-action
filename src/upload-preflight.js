const fs = require("fs").promises;
const path = require("path");
const glob = require("@actions/glob");
const yauzl = require("yauzl");
const { crc32 } = require("node:zlib");
const { normalizeServerPath } = require("./server-path");

async function validateZip(buffer) {
  const zip = await yauzl.fromBufferPromise(buffer);
  try {
    for await (const entry of zip.eachEntry()) {
      const stream = await zip.openReadStreamPromise(entry);
      let checksum = 0;
      // Stream decompressed entries to verify content, without extracting or
      // retaining uncompressed data. yauzl also checks names and entry sizes.
      for await (const chunk of stream) checksum = crc32(chunk, checksum);
      if (checksum !== entry.crc32) {
        throw new Error(`ZIP CRC-32 mismatch for ${JSON.stringify(entry.fileName)}`);
      }
    }
  } finally {
    zip.close();
  }
}

function getTargetFile(targetPath, source) {
  return normalizeServerPath(targetPath.endsWith("/")
    ? path.posix.join(targetPath.replace(/\\/g, "/"), path.basename(source))
    : targetPath);
}

async function prepareUploads(settings) {
  if (!Array.isArray(settings.sourceListPath) || !Array.isArray(settings.targets)) {
    throw new Error("sources and config.targets must be arrays; cleanup not started");
  }
  const groups = [
    ...settings.sourceListPath.map((source) => ({ source, target: settings.targetPath })),
    ...settings.targets,
  ];
  const uploads = [];
  const cache = new Map();
  for (const group of groups) {
    if (!group || typeof group.source !== "string" || !group.source.trim() ||
        typeof group.target !== "string" || !group.target) {
      throw new Error("Every upload must have a source pattern and target; cleanup not started");
    }
    const globber = await glob.create(group.source, {
      followSymbolicLinks: settings.followSymbolicLinks,
    });
    const files = await globber.glob();
    if (!files.length) {
      throw new Error(`No source files matched ${JSON.stringify(group.source)}; cleanup not started`);
    }
    for (const source of files) {
      try {
        const targetFile = getTargetFile(group.target, source);
        let prepared = cache.get(source);
        if (!prepared) {
          // Reject FIFOs/special files before opening them could block.
          if (!(await fs.stat(source)).isFile()) {
            throw new Error("Source must be a regular file, not a directory or special file");
          }
          const handle = await fs.open(source, "r");
          try {
            const stats = await handle.stat();
            if (!stats.isFile()) throw new Error("Source must be a regular file, not a directory or special file");
            prepared = { buffer: await handle.readFile(), zipValidated: false };
          } finally {
            await handle.close();
          }
          cache.set(source, prepared);
        }
        if (!prepared.zipValidated && [source, targetFile].some((name) => path.extname(name).toLowerCase() === ".zip")) {
          await validateZip(prepared.buffer);
          prepared.zipValidated = true;
        }
        // Upload these exact checked bytes after cleanup, even if the local
        // file changes or disappears in the meantime.
        uploads.push({ source, targetFile, buffer: prepared.buffer });
      } catch (error) {
        throw new Error(`Cannot prepare source ${JSON.stringify(source)}: ${error.message}; cleanup not started`);
      }
    }
  }
  if (!uploads.length) throw new Error("No source files prepared; cleanup not started");
  return uploads;
}

module.exports = { prepareUploads, validateZip };
