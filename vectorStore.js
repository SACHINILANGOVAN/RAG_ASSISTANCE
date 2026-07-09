import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import sql from "mssql";
import { Document } from "@langchain/core/documents";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/hf_transformers";
import { embedTextsWithCache } from "./embeddingCache.js";
import { loadBm25Index, rebuildBm25IndexFromRows } from "./bm25Store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let embeddingsInstance = null;
let vectorRows = [];
let sqlPool = null;
let initialized = false;

const VECTORSTORE_FILE = "vectors.json";

function resolvePath(envPath, fallback) {
  const target = envPath || fallback;
  return path.isAbsolute(target) ? target : path.join(__dirname, target);
}

export function getUploadDir() {
  return resolvePath(process.env.UPLOAD_DIR, "uploads");
}

export function getVectorStoreDir() {
  return resolvePath(process.env.VECTORSTORE_DIR, "vectorstore");
}

function getVectorStoreFilePath() {
  return path.join(getVectorStoreDir(), VECTORSTORE_FILE);
}

async function getDirectorySizeBytes(dir) {
  let total = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySizeBytes(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export async function getStorageStats() {
  await ensureDirectories();
  const vectorStoreDir = getVectorStoreDir();
  const uploadDir = getUploadDir();
  const vectorStoreBytes = await getDirectorySizeBytes(vectorStoreDir);
  const uploadBytes = await getDirectorySizeBytes(uploadDir);
  const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB) || 25;
  const maxFiles = Number(process.env.MAX_UPLOAD_FILES) || 200;
  const configuredLimitBytes = Number(process.env.VECTORSTORE_MAX_SIZE_MB || 1024) * 1024 * 1024;
  const freeBytes = configuredLimitBytes > 0 ? Math.max(configuredLimitBytes - vectorStoreBytes, 0) : null;
  const approxMoreFiles = freeBytes === null ? null : Math.floor(freeBytes / Math.max(maxFileSizeMb * 1024 * 1024, 1));

  return {
    vectorStoreDir,
    uploadDir,
    vectorStoreBytes,
    uploadBytes,
    totalAppStorageBytes: vectorStoreBytes + uploadBytes,
    configuredLimitBytes,
    freeBytes,
    maxFileSizeMb,
    maxFilesPerUpload: maxFiles,
    approxMoreFiles,
  };
}

function getSqlConfig() {
  const server = process.env.DB_SERVER;
  const database = process.env.DB_DATABASE;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;

  if (!server || !database || !user) return null;

  return {
    server,
    port: Number(process.env.DB_PORT) || 1433,
    database,
    user,
    password: password ?? "",
    options: {
      encrypt: process.env.DB_ENCRYPT !== "false",
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
}

export function getEmbeddings() {
  if (!embeddingsInstance) {
    embeddingsInstance = new HuggingFaceTransformersEmbeddings({
      model: process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2",
    });
  }
  return embeddingsInstance;
}

export async function initDatabase() {
  const config = getSqlConfig();
  if (!config) {
    console.warn("[database] DB_* not set. Running without SQL Server metadata persistence.");
    return null;
  }

  try {
    sqlPool = await new sql.ConnectionPool(config).connect();
    await sqlPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents')
      BEGIN
        CREATE TABLE Documents (
          id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
          filename NVARCHAR(500) NOT NULL,
          stored_path NVARCHAR(1000) NOT NULL,
          file_type NVARCHAR(50) NULL,
          folder_path NVARCHAR(1000) NULL,
          content_hash NVARCHAR(128) NULL,
          file_version INT NOT NULL DEFAULT 1,
          num_pages INT NOT NULL DEFAULT 0,
          chunk_count INT NOT NULL DEFAULT 0,
          character_count INT NOT NULL DEFAULT 0,
          uploaded_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END

      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents') AND COL_LENGTH('Documents', 'file_type') IS NULL
        ALTER TABLE Documents ADD file_type NVARCHAR(50) NULL;
      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents') AND COL_LENGTH('Documents', 'folder_path') IS NULL
        ALTER TABLE Documents ADD folder_path NVARCHAR(1000) NULL;
      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents') AND COL_LENGTH('Documents', 'content_hash') IS NULL
        ALTER TABLE Documents ADD content_hash NVARCHAR(128) NULL;
      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents') AND COL_LENGTH('Documents', 'file_version') IS NULL
        ALTER TABLE Documents ADD file_version INT NOT NULL DEFAULT 1;

      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ChatLogs')
      BEGIN
        CREATE TABLE ChatLogs (
          id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
          question NVARCHAR(MAX) NOT NULL,
          answer NVARCHAR(MAX) NOT NULL,
          sources NVARCHAR(MAX) NULL,
          created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END
    `);
    console.log("[database] Connected to SQL Server and schema is ready.");
    return sqlPool;
  } catch (err) {
    console.warn(`[database] SQL Server unavailable (${err.message}). Continuing without DB.`);
    sqlPool = null;
    return null;
  }
}

export async function registerDocument({
  filename,
  storedPath,
  fileType,
  folderPath,
  contentHash,
  fileVersion,
  numPages,
  chunkCount,
  characterCount,
}) {
  if (!sqlPool) return { id: null, skipped: true };

  await sqlPool.request().input("filename", sql.NVarChar(500), filename)
    .query(`DELETE FROM Documents WHERE filename = @filename`);

  const result = await sqlPool.request()
    .input("filename", sql.NVarChar(500), filename)
    .input("stored_path", sql.NVarChar(1000), storedPath)
    .input("file_type", sql.NVarChar(50), fileType || null)
    .input("folder_path", sql.NVarChar(1000), folderPath || null)
    .input("content_hash", sql.NVarChar(128), contentHash || null)
    .input("file_version", sql.Int, fileVersion ?? 1)
    .input("num_pages", sql.Int, numPages || 0)
    .input("chunk_count", sql.Int, chunkCount || 0)
    .input("character_count", sql.Int, characterCount || 0)
    .query(`
      INSERT INTO Documents (filename, stored_path, file_type, folder_path, content_hash, file_version, num_pages, chunk_count, character_count)
      OUTPUT INSERTED.id, INSERTED.filename, INSERTED.uploaded_at
      VALUES (@filename, @stored_path, @file_type, @folder_path, @content_hash, @file_version, @num_pages, @chunk_count, @character_count)
    `);

  const row = result.recordset[0];
  return { id: row.id, filename: row.filename, uploadedAt: row.uploaded_at, skipped: false };
}

export async function listDocuments() {
  if (!sqlPool) return [];
  const result = await sqlPool.request().query(`
    SELECT id, filename, file_type, folder_path, file_version, num_pages, chunk_count, character_count, uploaded_at
    FROM Documents
    ORDER BY uploaded_at DESC
  `);
  return result.recordset;
}

export async function logChat({ question, answer, sources }) {
  if (!sqlPool) return;
  await sqlPool.request()
    .input("question", sql.NVarChar(sql.MAX), question)
    .input("answer", sql.NVarChar(sql.MAX), answer)
    .input("sources", sql.NVarChar(sql.MAX), JSON.stringify(sources))
    .query(`INSERT INTO ChatLogs (question, answer, sources) VALUES (@question, @answer, @sources)`);
}

export async function ensureDirectories() {
  await fs.mkdir(getUploadDir(), { recursive: true });
  await fs.mkdir(getVectorStoreDir(), { recursive: true });
}

function makeDocument(row) {
  return new Document({ pageContent: row.pageContent, metadata: row.metadata || {} });
}

export async function loadOrCreateFaissStore() {
  await ensureDirectories();
  try {
    const raw = await fs.readFile(getVectorStoreFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    vectorRows = Array.isArray(parsed.rows) ? parsed.rows : [];
    console.log(`[vectorstore] Loaded ${vectorRows.length} vector rows from JSON store.`);
  } catch {
    vectorRows = [];
    console.log("[vectorstore] Created new JSON vector store.");
  }
  return { rows: vectorRows, index: { ntotal: () => vectorRows.length } };
}

export async function initVectorStore() {
  if (initialized) return { rows: vectorRows, index: { ntotal: () => vectorRows.length } };
  await ensureDirectories();
  await initDatabase();
  await loadOrCreateFaissStore();
  await loadBm25Index();
  initialized = true;
  return { rows: vectorRows, index: { ntotal: () => vectorRows.length } };
}

export async function addDocuments(documents) {
  if (!documents?.length) throw new Error("No document chunks to add to the vector store.");

  const embeddings = getEmbeddings();
  const texts = documents.map((d) => d.pageContent);
  const vectors = await embedTextsWithCache(texts, embeddings);

  documents.forEach((doc, index) => {
    vectorRows.push({
      pageContent: doc.pageContent,
      metadata: doc.metadata || {},
      vector: vectors[index],
    });
  });

  await persistFaissStore();
  return { rows: vectorRows, index: { ntotal: () => vectorRows.length } };
}

export function getVectorCount() {
  return vectorRows.length;
}

export async function persistFaissStore() {
  await ensureDirectories();
  await fs.writeFile(
    getVectorStoreFilePath(),
    JSON.stringify({ rows: vectorRows, savedAt: new Date().toISOString() }),
    "utf8"
  );
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function similaritySearchWithScore(query, k) {
  if (!vectorRows.length) await loadOrCreateFaissStore();
  if (!vectorRows.length) return [];

  const topK = Number(k) || Number(process.env.TOP_K) || 5;
  const queryVector = await getEmbeddings().embedQuery(query);

  return vectorRows
    .map((row) => [makeDocument(row), cosineSimilarity(queryVector, row.vector)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(topK, vectorRows.length));
}

export function hasIndexedDocuments() {
  return vectorRows.length > 0;
}


export async function deleteDocumentRecordByFilename(filename) {
  if (!sqlPool) return { skipped: true };
  await sqlPool.request()
    .input("filename", sql.NVarChar(500), filename)
    .query(`DELETE FROM Documents WHERE filename = @filename`);
  return { skipped: false };
}

export async function deleteVectorsByFileKey(fileKey) {
  const key = (fileKey || "").replace(/\\/g, "/").toLowerCase();
  const before = vectorRows.length;
  vectorRows = vectorRows.filter((row) => row?.metadata?.fileKey !== key);
  const deleted = before - vectorRows.length;
  await persistFaissStore();
  await rebuildBm25IndexFromRows(vectorRows);
  return { deleted, vectorCount: vectorRows.length };
}

export async function closeConnections() {
  if (sqlPool) {
    try { await sqlPool.close(); } catch { /* ignore */ }
    sqlPool = null;
  }
}
