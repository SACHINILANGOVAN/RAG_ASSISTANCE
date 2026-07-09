import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getVectorStoreDir } from "./vectorStore.js";

let manifest = null;
const MANIFEST_FILE = "index-manifest.json";

function defaultManifest() {
  return {
    version: 1,
    lastIndexingAt: null,
    files: {},
    stats: { totalChunks: 0, totalFiles: 0 },
  };
}

export function getFileKey(source) {
  return (source || "").replace(/\\/g, "/").toLowerCase();
}

export function getFolderPath(source) {
  const normalized = (source || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : "";
}

export async function computeFileHash(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function manifestPath() {
  return path.join(getVectorStoreDir(), MANIFEST_FILE);
}

export async function loadManifest() {
  if (manifest) return manifest;
  try {
    const raw = await fs.readFile(manifestPath(), "utf8");
    manifest = JSON.parse(raw);
  } catch {
    manifest = defaultManifest();
  }
  return manifest;
}

export async function saveManifest() {
  if (!manifest) manifest = defaultManifest();
  manifest.lastIndexingAt = new Date().toISOString();
  await fs.mkdir(getVectorStoreDir(), { recursive: true });
  await fs.writeFile(manifestPath(), JSON.stringify(manifest, null, 2), "utf8");
}

export async function shouldIndexFile(fileKey, contentHash) {
  await loadManifest();
  const entry = manifest.files[fileKey];
  if (!entry) return { index: true, reason: "new" };
  if (entry.contentHash === contentHash) {
    return { index: false, reason: "unchanged", entry };
  }
  return { index: true, reason: "modified", entry };
}

export async function registerIndexedFile({
  fileKey,
  source,
  folderPath,
  fileType,
  contentHash,
  fileVersion,
  chunkCount,
  numPages,
  characterCount,
}) {
  await loadManifest();

  manifest.files[fileKey] = {
    source,
    folderPath: folderPath || getFolderPath(source),
    fileType,
    contentHash,
    fileVersion: fileVersion ?? 1,
    chunkCount,
    numPages,
    characterCount,
    indexedAt: new Date().toISOString(),
  };

  recalcStats();
  await saveManifest();
  return manifest.files[fileKey];
}

export function getActiveFileVersion(fileKey) {
  return manifest?.files?.[fileKey]?.fileVersion ?? 0;
}

export async function getManifestStats() {
  await loadManifest();
  return {
    totalFiles: manifest.stats?.totalFiles ?? 0,
    totalChunks: manifest.stats?.totalChunks ?? 0,
    lastIndexingAt: manifest.lastIndexingAt,
    files: manifest.files,
  };
}

export async function listManifestFiles(filters = {}) {
  await loadManifest();
  let entries = Object.entries(manifest.files || {}).map(([fileKey, meta]) => ({
    fileKey,
    ...meta,
  }));

  if (filters.fileType) {
    entries = entries.filter((e) => e.fileType === filters.fileType);
  }
  if (filters.folderPath) {
    const fp = filters.folderPath.replace(/\\/g, "/");
    entries = entries.filter(
      (e) => e.folderPath?.startsWith(fp) || e.source?.startsWith(fp)
    );
  }
  return entries;
}

function recalcStats() {
  const files = Object.values(manifest.files || {});
  manifest.stats.totalFiles = files.length;
  manifest.stats.totalChunks = files.reduce((sum, f) => sum + (f.chunkCount || 0), 0);
}

export async function deleteManifestFile(fileKey) {
  await loadManifest();
  const key = getFileKey(fileKey);
  const existing = manifest.files?.[key];
  if (!existing) return null;
  delete manifest.files[key];
  recalcStats();
  await saveManifest();
  return { fileKey: key, ...existing };
}
