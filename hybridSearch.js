import { Document } from "@langchain/core/documents";
import { similaritySearchWithScore } from "./vectorStore.js";
import { bm25Search } from "./bm25Store.js";
import { getActiveFileVersion, loadManifest } from "./indexManifest.js";

/**
 * Reciprocal Rank Fusion merge for vector + BM25 results.
 */
function reciprocalRankFusion(resultLists, k = 60) {
  const scores = new Map();

  for (const list of resultLists) {
    list.forEach((item, rank) => {
      const meta = item.doc.metadata || {};
      const key =
        meta.chunkRef ||
        `${meta.fileKey || meta.source}::${meta.fileVersion}::${meta.chunkIndex}`;

      const rrf = 1 / (k + rank + 1);
      const prev = scores.get(key) || { doc: item.doc, score: 0, methods: new Set() };
      prev.score += rrf * (item.weight ?? 1);
      if (item.method) prev.methods.add(item.method);
      scores.set(key, prev);
    });
  }

  return [...scores.entries()]
    .map(([key, val]) => ({
      doc: val.doc,
      score: val.score,
      methods: [...val.methods],
      chunkRef: key,
    }))
    .sort((a, b) => b.score - a.score);
}

async function filterActiveVersions(results) {
  await loadManifest();
  return results.filter((item) => {
    const fk = item.doc.metadata?.fileKey;
    if (!fk) return true;
    const ver = item.doc.metadata?.fileVersion;
    if (ver === undefined || ver === null) return true;
    const active = getActiveFileVersion(fk);
    return ver === active;
  });
}

export async function hybridSearch(query, options = {}) {
  const topK = Number(options.topK) || Number(process.env.TOP_K) || 5;
  const fetchK = topK * 4;
  const filters = options.filters || {};

  const [vectorRows, bm25Rows] = await Promise.all([
    similaritySearchWithScore(query, fetchK),
    bm25Search(query, fetchK, filters),
  ]);

  const vectorWeight = Number(process.env.HYBRID_VECTOR_WEIGHT) || 1;
  const bm25Weight = Number(process.env.HYBRID_BM25_WEIGHT) || 1;

  const vectorList = vectorRows.map(([doc]) => ({
    doc,
    method: "vector",
    weight: vectorWeight,
  }));
  const bm25List = bm25Rows.map((row) => ({
    doc: row.doc,
    method: "bm25",
    weight: bm25Weight,
  }));

  let merged = reciprocalRankFusion([vectorList, bm25List], 60);

  merged = await filterActiveVersions(merged);

  if (filters.fileType) {
    merged = merged.filter((m) => m.doc.metadata?.fileType === filters.fileType);
  }
  if (filters.folderPath) {
    const fp = filters.folderPath.replace(/\\/g, "/");
    merged = merged.filter(
      (m) =>
        m.doc.metadata?.folderPath?.startsWith(fp) ||
        m.doc.metadata?.source?.startsWith(fp)
    );
  }

  return merged.slice(0, topK).map((m) => [m.doc, m.score]);
}
