import fs from "fs/promises";
import path from "path";
import MiniSearch from "minisearch";
import { getVectorStoreDir } from "./vectorStore.js";

const BM25_FILE = "bm25-index.json";

let miniSearch = null;
let docIdCounter = 0;

function indexPath() {
  return path.join(getVectorStoreDir(), BM25_FILE);
}

function createIndex() {
  return new MiniSearch({
    fields: ["text"],
    storeFields: [
      "source",
      "fileKey",
      "fileVersion",
      "chunkIndex",
      "chunkRef",
      "pageNumber",
      "folderPath",
      "fileType",
    ],
    searchOptions: {
      boost: { text: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
}

export async function loadBm25Index() {
  if (miniSearch) return miniSearch;

  miniSearch = createIndex();

  try {
    const raw = await fs.readFile(indexPath(), "utf8");
    const data = JSON.parse(raw);
    const opts = {
      fields: ["text"],
      storeFields: [
        "source",
        "fileKey",
        "fileVersion",
        "chunkIndex",
        "chunkRef",
        "pageNumber",
        "folderPath",
        "fileType",
      ],
    };
    miniSearch = MiniSearch.loadJSON(JSON.stringify(data.index ?? data), opts);
    docIdCounter = data.docIdCounter ?? 0;
  } catch {
    miniSearch = createIndex();
    docIdCounter = 0;
  }

  return miniSearch;
}

export async function saveBm25Index() {
  if (!miniSearch) return;
  const payload = {
    docIdCounter,
    index: miniSearch.toJSON(),
  };
  await fs.mkdir(getVectorStoreDir(), { recursive: true });
  await fs.writeFile(indexPath(), JSON.stringify(payload), "utf8");
}

export async function addChunksToBm25(documents) {
  const index = await loadBm25Index();
  const records = documents.map((doc) => {
    const id = String(docIdCounter++);
    const meta = doc.metadata || {};
    return {
      id,
      text: doc.pageContent,
      source: meta.source,
      fileKey: meta.fileKey,
      fileVersion: meta.fileVersion,
      chunkIndex: meta.chunkIndex,
      chunkRef: meta.chunkRef,
      pageNumber: meta.pageNumber ?? null,
      folderPath: meta.folderPath ?? "",
      fileType: meta.fileType,
    };
  });

  index.addAll(records);
  await saveBm25Index();
  return records.length;
}

export async function bm25Search(query, k = 10, filters = {}) {
  const index = await loadBm25Index();
  if (index.documentCount === 0) return [];

  const results = index.search(query, { limit: k * 3 });

  return results
    .filter((r) => {
      if (filters.fileType && r.fileType !== filters.fileType) return false;
      if (filters.folderPath) {
        const fp = filters.folderPath.replace(/\\/g, "/");
        if (!r.folderPath?.startsWith(fp) && !r.source?.startsWith(fp)) return false;
      }
      if (filters.fileKey && r.fileKey !== filters.fileKey) return false;
      if (typeof filters.fileVersion === "number" && r.fileVersion !== filters.fileVersion) {
        return false;
      }
      return true;
    })
    .slice(0, k)
    .map((r) => ({
      doc: {
        pageContent: r.text,
        metadata: {
          source: r.source,
          fileKey: r.fileKey,
          fileVersion: r.fileVersion,
          chunkIndex: r.chunkIndex,
          chunkRef: r.chunkRef,
          pageNumber: r.pageNumber,
          folderPath: r.folderPath,
          fileType: r.fileType,
        },
      },
      score: r.score,
      method: "bm25",
    }));
}

export function getBm25DocumentCount() {
  return miniSearch?.documentCount ?? 0;
}

export async function rebuildBm25IndexFromRows(rows = []) {
  miniSearch = createIndex();
  docIdCounter = 0;

  const records = rows.map((row) => {
    const id = String(docIdCounter++);
    const meta = row.metadata || {};
    return {
      id,
      text: row.pageContent || "",
      source: meta.source,
      fileKey: meta.fileKey,
      fileVersion: meta.fileVersion,
      chunkIndex: meta.chunkIndex,
      chunkRef: meta.chunkRef,
      pageNumber: meta.pageNumber ?? null,
      folderPath: meta.folderPath ?? "",
      fileType: meta.fileType,
    };
  });

  if (records.length) miniSearch.addAll(records);
  await saveBm25Index();
  return records.length;
}
