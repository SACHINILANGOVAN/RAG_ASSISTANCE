import Tesseract from "tesseract.js";

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker(process.env.OCR_LANG || "eng");
  }
  return workerPromise;
}

export async function recognizeImageBuffer(buffer, label = "image") {
  const worker = await getWorker();
  const { data } = await worker.recognize(buffer);
  const text = (data?.text || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error(`OCR produced no text for ${label}.`);
  }
  return { text, numPages: 1, ocr: true };
}

export async function recognizeImageFile(filePath, label) {
  const fs = await import("fs/promises");
  const buffer = await fs.readFile(filePath);
  return recognizeImageBuffer(buffer, label || filePath);
}

export async function recognizePdfWithOcr(filePath) {
  // Node 25 friendly build: PDF OCR rendering through pdf-img-convert/canvas was removed
  // because canvas@2.x has no prebuilt binary for Node 25 on Windows.
  // Text-based PDFs are still handled by pdf-parse/pdfjs in fileProcessor.js.
  throw new Error(
    `Scanned/image-only PDF OCR is disabled in this Node 25 build (${filePath}). ` +
      "Use a text-based PDF, upload image pages directly, or run the OCR build on Node 22 LTS."
  );
}

export async function shutdownOcr() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
