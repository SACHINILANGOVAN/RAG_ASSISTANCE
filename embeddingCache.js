import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getVectorStoreDir } from "./vectorStore.js";

const CACHE_DIR_NAME = "embedding-cache";

function cacheDir() {
  return path.join(getVectorStoreDir(), CACHE_DIR_NAME);
}

function cacheKey(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cacheFilePath(key) {
  return path.join(cacheDir(), `${key}.json`);
}

export async function embedTextsWithCache(texts, embeddings) {
  await fs.mkdir(cacheDir(), { recursive: true });

  const vectors = [];
  const toEmbed = [];
  const toEmbedIndexes = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const key = cacheKey(text);

    try {
      const raw = await fs.readFile(cacheFilePath(key), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.vector)) {
        vectors[i] = parsed.vector;
        continue;
      }
    } catch {
      /* cache miss */
    }

    toEmbed.push(text);
    toEmbedIndexes.push(i);
  }

  if (toEmbed.length > 0) {
    const newVectors = await embeddings.embedDocuments(toEmbed);
    for (let j = 0; j < newVectors.length; j++) {
      const idx = toEmbedIndexes[j];
      vectors[idx] = newVectors[j];
      const key = cacheKey(toEmbed[j]);
      await fs.writeFile(
        cacheFilePath(key),
        JSON.stringify({ vector: newVectors[j], cachedAt: new Date().toISOString() }),
        "utf8"
      ).catch(() => {});
    }
  }

  return vectors;
}
