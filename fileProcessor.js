import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { recognizeImageFile, recognizePdfWithOcr } from "./ocrService.js";

export const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".yaml",
  ".yml",
  ".sql",
  ".rtf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".xls",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".py",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".css",
  ".scss",
  ".less",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
]);

export const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".msi",
  ".bin",
  ".iso",
  ".img",
  ".dmg",
  ".deb",
  ".rpm",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".mkv",
  ".wav",
  ".flac",
  ".gif",
  ".bmp",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".db",
  ".sqlite",
  ".bak",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const TEXT_LIKE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm",
  ".log", ".yaml", ".yml", ".sql", ".js", ".ts", ".jsx", ".tsx", ".py", ".java",
  ".cs", ".cpp", ".c", ".h", ".css", ".scss", ".less", ".ini", ".cfg", ".conf",
  ".env", ".rtf",
]);

const MAX_TEXT_FILE_BYTES = Number(process.env.MAX_TEXT_FILE_BYTES) || 10 * 1024 * 1024;

export function getExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

export function normalizeSourceName(originalName) {
  return (originalName || "unknown").replace(/\\/g, "/");
}

export function isSupportedExtension(ext) {
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function isBlockedExtension(ext) {
  return BLOCKED_EXTENSIONS.has(ext);
}

export function isZipExtension(ext) {
  return ext === ".zip";
}

export function isImageExtension(ext) {
  return IMAGE_EXTENSIONS.has(ext);
}

export function validateAttachmentUpload(file) {
  if (!file) throw new Error("No file was uploaded.");

  const source = normalizeSourceName(file.originalname);
  const ext = getExtension(source);

  if (!ext) throw new Error(`File has no extension: ${source}`);
  if (isBlockedExtension(ext)) {
    throw new Error(`Blocked file type (${ext}): ${source}`);
  }
  if (!isSupportedExtension(ext)) {
    throw new Error(`Unsupported file type (${ext}): ${source}`);
  }
}

async function readFileBuffer(filePath) {
  const buffer = await fs.readFile(filePath);
  if (!buffer?.length) throw new Error("File is empty.");
  return buffer;
}

async function extractPdfPagesWithPdfJs(buffer) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pageTexts = [];

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str).join(" ").trim();
      if (text) pageTexts.push({ pageNumber: i, text });
    }

    if (pageTexts.length === 0) return null;

    const text = pageTexts.map((p) => `[Page ${p.pageNumber}]\n${p.text}`).join("\n\n");
    return { text, numPages: doc.numPages, pageTexts, fileType: "pdf" };
  } catch {
    return null;
  }
}

async function extractFromPdf(filePath, buffer) {
  try {
    const parsed = await pdfParse(buffer);
    const text = (parsed.text || "").replace(/\r\n/g, "\n").trim();
    if (text.length > 50) {
      return { text, numPages: parsed.numpages ?? 0, fileType: "pdf", pageTexts: null };
    }
  } catch (err) {
    if (!process.env.ENABLE_OCR || process.env.ENABLE_OCR === "false") {
      throw new Error(`Failed to parse PDF: ${err.message}`);
    }
  }

  const paged = await extractPdfPagesWithPdfJs(buffer);
  if (paged?.text) return paged;

  if (process.env.ENABLE_OCR !== "false") {
    return recognizePdfWithOcr(filePath);
  }

  throw new Error("No extractable text in PDF. Enable OCR or use a text-based PDF.");
}

async function extractFromPlainText(buffer, ext) {
  const text = buffer.toString("utf8").replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("File contains no readable text.");
  return { text, numPages: 0, fileType: ext.replace(".", "") || "text", pageTexts: null };
}

async function extractFromDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = (result.value || "").replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("No extractable text in Word document.");
  return { text, numPages: 0, fileType: "docx", pageTexts: null };
}

async function extractFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) parts.push(`## Sheet: ${sheetName}\n${csv}`);
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("No extractable data in spreadsheet.");
  return { text, numPages: workbook.SheetNames.length, fileType: "excel", pageTexts: null };
}

async function extractFromOfficeParser(filePath, fileType) {
  const mod = await import("officeparser");
  const parser = mod.default ?? mod.officeParser ?? mod;
  let raw;
  if (typeof parser.parseOfficeAsync === "function") {
    raw = await parser.parseOfficeAsync(filePath);
  } else {
    raw = await new Promise((resolve, reject) => {
      parser.parseOffice(filePath, (data, err) => (err ? reject(err) : resolve(data)));
    });
  }
  const text = (raw || "").toString().replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error(`No extractable text in ${fileType} file.`);
  return { text, numPages: 0, fileType, pageTexts: null };
}

export async function extractTextFromFile(filePath, originalName) {
  const source = normalizeSourceName(originalName || path.basename(filePath));
  const ext = getExtension(source);

  if (isBlockedExtension(ext)) throw new Error(`Blocked file type: ${ext}`);
  if (!isSupportedExtension(ext)) throw new Error(`Unsupported file type: ${ext}`);
  if (isZipExtension(ext)) {
    throw new Error("ZIP archives must be extracted before text extraction.");
  }

  const stat = await fs.stat(filePath);
  if (stat.size > MAX_TEXT_FILE_BYTES && TEXT_LIKE_EXTENSIONS.has(ext)) {
    throw new Error(`File too large (max ${MAX_TEXT_FILE_BYTES} bytes): ${source}`);
  }

  if (isImageExtension(ext)) {
    const ocr = await recognizeImageFile(filePath, source);
    return { ...ocr, source, fileType: ext.replace(".", ""), pageTexts: [{ pageNumber: 1, text: ocr.text }] };
  }

  const buffer = await readFileBuffer(filePath);

  let extracted;
  switch (ext) {
    case ".pdf":
      extracted = await extractFromPdf(filePath, buffer);
      break;
    case ".docx":
      extracted = await extractFromDocx(filePath);
      break;
    case ".xlsx":
    case ".xls":
      extracted = await extractFromExcel(buffer);
      break;
    case ".pptx":
      extracted = await extractFromOfficeParser(filePath, "pptx");
      break;
    default:
      if (TEXT_LIKE_EXTENSIONS.has(ext)) {
        extracted = await extractFromPlainText(buffer, ext);
      } else {
        throw new Error(`No extractor configured for ${ext}`);
      }
  }

  return { ...extracted, source };
}

function estimatePageNumber(chunkIndex, totalChunks, numPages) {
  if (!numPages || numPages <= 0 || totalChunks <= 0) return null;
  return Math.min(numPages, Math.max(1, Math.floor((chunkIndex / totalChunks) * numPages) + 1));
}

export async function splitIntoChunks({
  text,
  source,
  fileKey,
  fileVersion,
  folderPath,
  documentId,
  fileType,
  numPages,
  pageTexts,
  chunkSize = 1000,
  chunkOverlap = 200,
}) {
  if (!text?.trim()) throw new Error("Text content is required for chunking.");
  if (!source) throw new Error("Source path is required.");

  const size = Number(chunkSize) || 1000;
  const overlap = Number(chunkOverlap) || 200;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: size,
    chunkOverlap: overlap,
    separators: ["\n\n\n", "\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""],
  });

  const rawChunks = await splitter.splitText(text);
  const totalChunks = rawChunks.length;

  return rawChunks.map((chunk, index) => {
    let pageNumber = estimatePageNumber(index, totalChunks, numPages);

    const pageMatch = chunk.match(/\[Page (\d+)\]/i);
    if (pageMatch) pageNumber = Number(pageMatch[1]);

    const chunkRef = `${fileKey}#v${fileVersion}#c${index}`;

    return new Document({
      pageContent: chunk,
      metadata: {
        source,
        fileKey,
        fileVersion,
        folderPath: folderPath || "",
        fileType: fileType ?? getExtension(source).replace(".", ""),
        documentId: documentId ?? null,
        chunkIndex: index,
        chunkRef,
        pageNumber,
        totalChunks,
        numPages: numPages || 0,
      },
    });
  });
}

export async function processAttachmentFile({
  filePath,
  originalName,
  documentId,
  fileKey,
  fileVersion,
  chunkSize,
  chunkOverlap,
}) {
  const { text, numPages, fileType, source, pageTexts } = await extractTextFromFile(
    filePath,
    originalName
  );

  const fk = fileKey || source.toLowerCase();
  const fv = fileVersion ?? 1;

  const documents = await splitIntoChunks({
    text,
    source,
    fileKey: fk,
    fileVersion: fv,
    folderPath: source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "",
    documentId,
    fileType,
    numPages,
    pageTexts,
    chunkSize,
    chunkOverlap,
  });

  return {
    documents,
    numPages,
    fileType,
    source,
    characterCount: text.length,
    chunkCount: documents.length,
  };
}

export const processPdfFile = processAttachmentFile;
export const validatePdfUpload = validateAttachmentUpload;

export function getAcceptAttribute() {
  return [...SUPPORTED_EXTENSIONS].join(",");
}

export function listSupportedTypes() {
  return [...SUPPORTED_EXTENSIONS].sort();
}
