import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import {
  ingestAttachments,
  answerQuestion,
  answerQuestionStream,
  getAppStatus,
  getKnowledgeDashboard,
  deleteIndexedFile,
} from "./rag.js";
import {
  isSupportedExtension,
  isBlockedExtension,
  getExtension,
} from "./fileProcessor.js";
import {
  initVectorStore,
  closeConnections,
  getUploadDir,
  ensureDirectories,
} from "./vectorStore.js";
import { shutdownOcr } from "./ocrService.js";
import { clearSession } from "./chatMemory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(
  express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".css")) {
        res.setHeader("Content-Type", "text/css; charset=utf-8");
      } else if (filePath.endsWith(".js")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      }
    },
  })
);

app.get("/style.css", (_req, res) => {
  res.type("text/css");
  res.sendFile(path.join(publicDir, "style.css"));
});

app.get("/app.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(publicDir, "app.js"));
});

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureDirectories();
      cb(null, getUploadDir());
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const relative = (file.originalname || "file").replace(/\\/g, "/");
    const safePath = relative.replace(/[^a-zA-Z0-9._\-/]/g, "_");
    const flatName = safePath.replace(/\//g, "__");
    cb(null, `${unique}-${flatName}`);
  },
});

const maxFiles = Number(process.env.MAX_UPLOAD_FILES) || 200;
const maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB) || 25;

const upload = multer({
  storage,
  limits: {
    fileSize: maxFileSizeMb * 1024 * 1024,
    files: maxFiles,
  },
  fileFilter: (_req, file, cb) => {
    const ext = getExtension(file.originalname);
    if (!ext) {
      return cb(new Error(`File must have an extension: ${file.originalname}`));
    }
    if (isBlockedExtension(ext)) {
      return cb(new Error(`Blocked file type (${ext}): ${file.originalname}`));
    }
    if (!isSupportedExtension(ext)) {
      return cb(new Error(`Unsupported file type (${ext}): ${file.originalname}`));
    }
    cb(null, true);
  },
});


function sanitizeUploadName(name) {
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/[^a-zA-Z0-9._\-/]/g, "_")
    .replace(/\//g, "__");
}

async function findUploadedFileForDocument(fileKey) {
  const status = await getAppStatus();
  const decodedKey = decodeURIComponent(fileKey || "");
  const keyLower = decodedKey.replace(/\\/g, "/").toLowerCase();
  const doc = (status.documents || []).find((item) => {
    const itemKey = String(item.fileKey || item.filename || "").replace(/\\/g, "/").toLowerCase();
    return itemKey === keyLower;
  });

  if (!doc) return null;

  const uploadDir = getUploadDir();
  const safeOriginal = sanitizeUploadName(doc.filename || doc.source || decodedKey);
  const fileNames = await fs.readdir(uploadDir).catch(() => []);

  const match = fileNames.find((name) => name.endsWith(`-${safeOriginal}`))
    || fileNames.find((name) => name.includes(safeOriginal))
    || fileNames.find((name) => name.endsWith(path.basename(safeOriginal)));

  if (!match) return { doc, filePath: null };
  return { doc, filePath: path.join(uploadDir, match) };
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/status", asyncHandler(async (_req, res) => {
  res.json(await getAppStatus());
}));

app.get("/api/dashboard", asyncHandler(async (_req, res) => {
  res.json(await getKnowledgeDashboard());
}));

app.get("/api/documents", asyncHandler(async (_req, res) => {
  const status = await getAppStatus();
  res.json({ documents: status.documents, dashboard: status.dashboard });
}));


app.get("/api/documents/download/:fileKey", asyncHandler(async (req, res) => {
  const result = await findUploadedFileForDocument(req.params.fileKey);

  if (!result?.doc) {
    return res.status(404).json({ error: "Indexed document not found." });
  }

  if (!result.filePath) {
    return res.status(404).json({
      error: "Original uploaded file not found in uploads folder. Re-upload this file once to enable download.",
    });
  }

  const downloadName = path.basename(result.doc.filename || "download");
  res.download(result.filePath, downloadName);
}));

app.delete("/api/documents/:fileKey", asyncHandler(async (req, res) => {
  res.json(await deleteIndexedFile(decodeURIComponent(req.params.fileKey)));
}));

app.post(
  "/upload",
  upload.fields([
    { name: "attachments", maxCount: maxFiles },
    { name: "pdfs", maxCount: maxFiles },
  ]),
  asyncHandler(async (req, res) => {
    const files = [...(req.files?.attachments || []), ...(req.files?.pdfs || [])];

    if (!files.length) {
      return res.status(400).json({
        error: "No files received. Use form field 'attachments' (files or folder).",
      });
    }

    const result = await ingestAttachments(files);
    res.status(201).json(result);
  })
);

app.post("/chat", asyncHandler(async (req, res) => {
  const { question, sessionId, fileType, folderPath, stream } = req.body;

  if (!question || typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "A non-empty question is required." });
  }

  const options = {
    sessionId,
    fileType: fileType || null,
    folderPath: folderPath || null,
  };

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      const result = await answerQuestionStream(
        question,
        options,
        (token) => {
          res.write(`data: ${JSON.stringify({ type: "token", token })}\n\n`);
        }
      );

      res.write(
        `data: ${JSON.stringify({
          type: "done",
          answer: result.answer,
          citations: result.citations,
          sources: result.sources,
          sessionId: result.sessionId,
        })}\n\n`
      );
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
      res.end();
    }
    return;
  }

  const result = await answerQuestion(question, options);
  res.json(result);
}));

app.delete("/api/session/:sessionId", (req, res) => {
  clearSession(req.params.sessionId);
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((err, req, res, _next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `File too large. Maximum size is ${maxFileSizeMb} MB per file.`
        : err.message;
    return res.status(400).json({ error: message });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: err.message || "Internal server error",
  });
});

async function startServer() {
  try {
    await initVectorStore();
    app.listen(PORT, () => {
      console.log(`RAG application running at http://localhost:${PORT}`);
      console.log("Features: hybrid search, OCR, incremental indexing, streaming chat.");
    });
  } catch (err) {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down...`);
  await closeConnections();
  await shutdownOcr();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startServer();