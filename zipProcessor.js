import fs from "fs/promises";
import path from "path";
import os from "os";
import AdmZip from "adm-zip";
import {
  getExtension,
  isSupportedExtension,
  isBlockedExtension,
  normalizeSourceName,
} from "./fileProcessor.js";

const MAX_ZIP_ENTRIES = Number(process.env.MAX_ZIP_ENTRIES) || 500;
const MAX_ZIP_DEPTH = 2;

/**
 * Extract ZIP and return list of supported files with virtual paths.
 * @param {string} zipPath
 * @param {string} archiveName - original upload name
 * @returns {Promise<Array<{ filePath: string, originalName: string }>>}
 */
export async function extractZipArchive(zipPath, archiveName) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (max ${MAX_ZIP_ENTRIES}).`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rag-zip-"));
  const baseName = normalizeSourceName(archiveName).replace(/\.zip$/i, "");
  const extracted = [];

  for (const entry of entries) {
    const entryName = entry.entryName.replace(/\\/g, "/");

    if (entryName.includes("..")) continue;

    const ext = getExtension(entryName);
    if (!ext || isBlockedExtension(ext)) continue;
    if (!isSupportedExtension(ext) && ext !== ".zip") continue;

    const outPath = path.join(tempRoot, entryName);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, entry.getData());

    const virtualName = `${baseName}/${entryName}`;

    if (ext === ".zip") {
      const nested = await extractZipArchive(outPath, virtualName);
      extracted.push(...nested);
    } else {
      extracted.push({ filePath: outPath, originalName: virtualName, tempRoot });
    }
  }

  return extracted;
}

export function isZipFile(filename) {
  return getExtension(filename) === ".zip";
}
