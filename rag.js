import path from "path";
import fs from "fs/promises";
import { ChatGroq } from "@langchain/groq";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import {
  processAttachmentFile,
  validateAttachmentUpload,
  normalizeSourceName,
  getExtension,
  listSupportedTypes,
} from "./fileProcessor.js";
import { extractZipArchive, isZipFile } from "./zipProcessor.js";
import {
  initVectorStore,
  addDocuments,
  registerDocument,
  listDocuments,
  logChat,
  hasIndexedDocuments,
  getUploadDir,
  getVectorCount,
  getStorageStats,
  deleteVectorsByFileKey,
  deleteDocumentRecordByFilename,
} from "./vectorStore.js";
import {
  computeFileHash,
  getFileKey,
  getFolderPath,
  shouldIndexFile,
  registerIndexedFile,
  getManifestStats,
  listManifestFiles,
  deleteManifestFile,
} from "./indexManifest.js";
import { addChunksToBm25, getBm25DocumentCount } from "./bm25Store.js";
import { hybridSearch } from "./hybridSearch.js";
import {
  getOrCreateSession,
  getHistoryForPrompt,
  appendToSession,
} from "./chatMemory.js";

async function expandUploadFiles(files) {
  const expanded = [];

  for (const file of files) {
    const displayName = normalizeSourceName(file.originalname);

    if (isZipFile(displayName)) {
      try {
        const extracted = await extractZipArchive(file.path, displayName);
        expanded.push(...extracted.map((e) => ({
          path: e.filePath,
          originalname: e.originalName,
          fromZip: true,
        })));
      } catch (err) {
        throw new Error(`ZIP extraction failed (${displayName}): ${err.message}`);
      }
    } else {
      expanded.push({
        path: file.path,
        originalname: displayName,
        fromZip: false,
        multerFile: file,
      });
    }
  }

  return expanded;
}

async function indexSingleFile({ filePath, originalName, chunkSize, chunkOverlap }) {
  validateAttachmentUpload({ originalname: originalName });

  const source = normalizeSourceName(originalName);
  const fileKey = getFileKey(source);
  const contentHash = await computeFileHash(filePath);

  const check = await shouldIndexFile(fileKey, contentHash);
  if (!check.index) {
    return {
      skipped: true,
      reason: check.reason,
      filename: source,
      fileKey,
      contentHash,
    };
  }

  const fileVersion = check.entry ? (check.entry.fileVersion || 0) + 1 : 1;

  const { documents, numPages, characterCount, chunkCount, fileType } =
    await processAttachmentFile({
      filePath,
      originalName: source,
      fileKey,
      fileVersion,
      chunkSize,
      chunkOverlap,
    });

  await addDocuments(documents);
  await addChunksToBm25(documents);

  const manifestEntry = await registerIndexedFile({
    fileKey,
    source,
    folderPath: getFolderPath(source),
    fileType,
    contentHash,
    fileVersion,
    chunkCount,
    numPages,
    characterCount,
  });

  let docRecord = { id: null, skipped: true };
  try {
    docRecord = await registerDocument({
      filename: source,
      storedPath: filePath,
      fileType,
      folderPath: getFolderPath(source),
      contentHash,
      fileVersion: manifestEntry.fileVersion,
      numPages,
      chunkCount,
      characterCount,
    });
  } catch (err) {
    console.warn(`[rag] DB register failed for ${source}: ${err.message}`);
  }

  return {
    skipped: false,
    filename: source,
    fileType,
    fileKey,
    documentId: docRecord.id,
    numPages,
    chunkCount,
    characterCount,
    contentHash,
    fileVersion: manifestEntry.fileVersion,
    storedPath: path.relative(getUploadDir(), filePath),
  };
}

export async function ingestAttachments(files) {
  if (!files?.length) throw new Error("At least one file is required.");

  await initVectorStore();

  const chunkSize = Number(process.env.CHUNK_SIZE) || 1000;
  const chunkOverlap = Number(process.env.CHUNK_OVERLAP) || 200;

  const expanded = await expandUploadFiles(files);
  const results = [];
  const skipped = [];
  const errors = [];

  for (const item of expanded) {
    try {
      const result = await indexSingleFile({
        filePath: item.path,
        originalName: item.originalname,
        chunkSize,
        chunkOverlap,
      });

      if (result.skipped) {
        skipped.push(result);
      } else {
        results.push(result);
      }
    } catch (err) {
      errors.push({ filename: item.originalname, error: err.message });
      console.warn(`[rag] Skipped ${item.originalname}: ${err.message}`);
    }
  }

  if (results.length === 0 && skipped.length === 0) {
    const detail = errors.map((e) => `${e.filename}: ${e.error}`).join("; ");
    throw new Error(detail || "No files could be processed.");
  }

  return {
    message: `Indexed ${results.length} file(s), skipped ${skipped.length} unchanged, ${errors.length} failed.`,
    documents: results,
    skipped,
    errors,
    totalDocuments: (await listDocuments()).length,
    indexed: hasIndexedDocuments(),
  };
}

export const ingestPdfFiles = ingestAttachments;

function buildContextFromChunks(scoredDocs) {
  const citations = [];
  const contextParts = [];

  scoredDocs.forEach(([doc, score], rank) => {
    const meta = doc.metadata || {};
    const source = meta.source || "Unknown";
    const chunkIndex = meta.chunkIndex ?? rank;
    const pageNumber = meta.pageNumber ?? null;
    const chunkRef = meta.chunkRef || `${source}#${chunkIndex}`;

    citations.push({
      rank: rank + 1,
      source,
      fileName: path.basename(source),
      folderPath: meta.folderPath || getFolderPath(source),
      fileType: meta.fileType || null,
      pageNumber,
      chunkIndex,
      chunkRef,
      score: typeof score === "number" ? Number(score.toFixed(4)) : score,
      excerpt: doc.pageContent.slice(0, 280) + (doc.pageContent.length > 280 ? "…" : ""),
    });

    const pageLabel = pageNumber ? ` | page ${pageNumber}` : "";
    contextParts.push(
      `[Source ${rank + 1}: ${source}${pageLabel} | chunk ${chunkIndex} | ref ${chunkRef}]\n${doc.pageContent}`
    );
  });

  return {
    context: contextParts.join("\n\n---\n\n"),
    citations,
  };
}

function createGroqModel({ streaming = false } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set. Add it to your .env file.");

  return new ChatGroq({
    apiKey,
    model: process.env.MODEL || "llama-3.3-70b-versatile",
    temperature: 0.2,
    maxTokens: 2048,
    streaming,
  });
}

const SYSTEM_PROMPT = `You are a helpful assistant that answers questions based on uploaded documents and attachments.

Rules:
1. Use the CONTEXT section and conversation history when relevant.
2. If context is insufficient, say you cannot find the answer in the indexed documents.
3. Answer only what the user asked. Do not show source names, page numbers, citations, chunk IDs, or reference details in the final answer.
4. Do not invent facts or sources.`;

function buildChatMessages({ question, context, history }) {
  const messages = [new SystemMessage(SYSTEM_PROMPT)];

  for (const turn of history) {
    if (turn.role === "user") messages.push(new HumanMessage(turn.content));
    if (turn.role === "assistant") messages.push(new AIMessage(turn.content));
  }

  messages.push(
    new HumanMessage(`CONTEXT:\n${context}\n\nQUESTION:\n${question}`)
  );

  return messages;
}

export async function answerQuestion(question, options = {}) {
  const trimmed = (question || "").trim();
  if (!trimmed) throw new Error("Question cannot be empty.");
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured.");

  const session = getOrCreateSession(options.sessionId);
  const history = getHistoryForPrompt(session.id);

  await initVectorStore();

  if (!hasIndexedDocuments()) {
    throw new Error("No documents are indexed yet. Upload files or a folder first.");
  }

  const topK = Number(options.topK) || Number(process.env.TOP_K) || 5;
  const filters = {
    fileType: options.fileType || null,
    folderPath: options.folderPath || null,
  };

  const scoredDocs = await hybridSearch(trimmed, { topK, filters });

  if (!scoredDocs?.length) {
    throw new Error("No relevant content found in the knowledge base.");
  }

  const { context, citations } = buildContextFromChunks(scoredDocs);
  const model = createGroqModel({ streaming: false });
  const messages = buildChatMessages({ question: trimmed, context, history });

  let response;
  try {
    response = await model.invoke(messages);
  } catch (err) {
    throw new Error(`Groq API request failed: ${err.message}`);
  }

  const answer =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("")
        : String(response.content ?? "");

  if (!answer) throw new Error("Received an empty response from the language model.");

  appendToSession(session.id, "user", trimmed);
  appendToSession(session.id, "assistant", answer);

  try {
    await logChat({ question: trimmed, answer, sources: citations });
  } catch (err) {
    console.warn(`[rag] Failed to log chat: ${err.message}`);
  }

  return {
    answer,
    citations,
    sources: [...new Set(citations.map((c) => c.source))],
    sessionId: session.id,
  };
}

export async function answerQuestionStream(question, options = {}, onToken) {
  const trimmed = (question || "").trim();
  if (!trimmed) throw new Error("Question cannot be empty.");
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not configured.");

  const session = getOrCreateSession(options.sessionId);
  const history = getHistoryForPrompt(session.id);

  await initVectorStore();

  if (!hasIndexedDocuments()) {
    throw new Error("No documents are indexed yet. Upload files or a folder first.");
  }

  const topK = Number(options.topK) || Number(process.env.TOP_K) || 5;
  const scoredDocs = await hybridSearch(trimmed, {
    topK,
    filters: {
      fileType: options.fileType || null,
      folderPath: options.folderPath || null,
    },
  });

  if (!scoredDocs?.length) {
    throw new Error("No relevant content found in the knowledge base.");
  }

  const { context, citations } = buildContextFromChunks(scoredDocs);
  const model = createGroqModel({ streaming: true });
  const messages = buildChatMessages({ question: trimmed, context, history });

  let fullAnswer = "";

  try {
    const stream = await model.stream(messages);
    for await (const chunk of stream) {
      const token =
        typeof chunk.content === "string"
          ? chunk.content
          : Array.isArray(chunk.content)
            ? chunk.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("")
            : "";
      if (token) {
        fullAnswer += token;
        if (onToken) onToken(token);
      }
    }
  } catch (err) {
    throw new Error(`Groq streaming failed: ${err.message}`);
  }

  if (!fullAnswer) throw new Error("Received an empty streamed response.");

  appendToSession(session.id, "user", trimmed);
  appendToSession(session.id, "assistant", fullAnswer);

  return {
    answer: fullAnswer,
    citations,
    sources: [...new Set(citations.map((c) => c.source))],
    sessionId: session.id,
  };
}

export async function getKnowledgeDashboard() {
  await initVectorStore();
  const manifest = await getManifestStats();
  const sqlDocs = await listDocuments();
  const storage = await getStorageStats();

  let vectorStatus = "empty";
  const vectors = getVectorCount();
  if (vectors > 0) vectorStatus = "ready";

  return {
    totalFilesIndexed: manifest.totalFiles,
    totalChunks: manifest.totalChunks,
    vectorCount: vectors,
    bm25DocumentCount: getBm25DocumentCount(),
    lastIndexingAt: manifest.lastIndexingAt,
    supportedFileTypes: listSupportedTypes(),
    vectorDatabaseStatus: vectorStatus,
    hybridSearchEnabled: true,
    ocrEnabled: process.env.ENABLE_OCR !== "false",
    sqlDocumentCount: sqlDocs.length,
    storage,
    recentFiles: Object.values(manifest.files || {})
      .sort((a, b) => new Date(b.indexedAt) - new Date(a.indexedAt))
      .slice(0, 10),
  };
}

export async function getAppStatus() {
  await initVectorStore();
  const dashboard = await getKnowledgeDashboard();
  const manifestFiles = await listManifestFiles();
  const documents = manifestFiles
    .sort((a, b) => new Date(b.indexedAt) - new Date(a.indexedAt))
    .map((d) => ({
      fileKey: d.fileKey,
      filename: d.source,
      fileType: d.fileType,
      folderPath: d.folderPath,
      fileVersion: d.fileVersion,
      numPages: d.numPages,
      chunkCount: d.chunkCount,
      characterCount: d.characterCount,
      uploadedAt: d.indexedAt,
    }));

  return {
    indexed: hasIndexedDocuments(),
    documentCount: documents.length,
    dashboard,
    documents,
  };
}

export async function deleteIndexedFile(fileKey) {
  await initVectorStore();
  const deletedManifest = await deleteManifestFile(fileKey);
  if (!deletedManifest) {
    const err = new Error("Indexed file not found.");
    err.status = 404;
    throw err;
  }

  const vectorResult = await deleteVectorsByFileKey(deletedManifest.fileKey);

  try {
    await deleteDocumentRecordByFilename(deletedManifest.source);
  } catch (err) {
    console.warn(`[rag] DB delete failed for ${deletedManifest.source}: ${err.message}`);
  }

  return {
    ok: true,
    deletedFile: deletedManifest.source,
    deletedChunks: vectorResult.deleted,
    remainingVectors: vectorResult.vectorCount,
  };
}
