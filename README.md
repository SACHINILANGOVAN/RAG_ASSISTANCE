# RAG PDF Assistant

Production-ready Retrieval Augmented Generation (RAG) application built with **Node.js**, **Express**, **LangChain JS**, **Groq**, **JSON vector store** (local filesystem), and **SQL Server (SSMS)** for document metadata.

Upload PDFs, index them with local embeddings, and ask grounded questions with source citations.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22+ / Node 25 compatible |
| Server | Express.js |
| RAG | LangChain JS |
| LLM | Groq API (`llama-3.3-70b-versatile`) |
| Embeddings | HuggingFace Transformers (local, `Xenova/all-MiniLM-L6-v2`) |
| Vector DB | Local JSON vector store on disk |
| Metadata DB | Microsoft SQL Server (SSMS) |
| PDF parsing | `pdf-parse` |
| Frontend | Vanilla HTML / CSS / JavaScript |

## Project Structure

```
rag-app/
├── package.json
├── .env.example
├── server.js
├── rag.js
├── pdfProcessor.js
├── vectorStore.js
├── uploads/
├── vectorstore/
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── README.md
```

## Prerequisites

1. **Node.js** 18 or later
2. **Groq API key** — [https://console.groq.com](https://console.groq.com)
3. **SQL Server** (optional but recommended) — LocalDB, Express, or full SSMS instance for document/chat metadata

## Quick Start

```bash
cd rag-app
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
GROQ_API_KEY=your_groq_api_key_here
```

Install and run:

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

> First run downloads the embedding model (~25 MB). First PDF upload may take a minute while embeddings are generated.

## SQL Server Setup (SSMS)

1. Open **SQL Server Management Studio** and connect to your instance.
2. Create a database:

```sql
CREATE DATABASE RAG_DB;
```

3. Configure `.env`:

```env
DB_SERVER=localhost
DB_PORT=1433
DB_DATABASE=RAG_DB
DB_USER=sa
DB_PASSWORD=YourStrong@Passw0rd
DB_TRUST_SERVER_CERTIFICATE=true
```

Tables (`Documents`, `ChatLogs`) are created automatically on startup.

If SQL Server is unavailable, the app still runs; FAISS indexing and chat work, but document metadata and chat logs are not persisted to SSMS.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `GROQ_API_KEY` | — | Groq API key (required for chat) |
| `MODEL` | `llama-3.3-70b-versatile` | Groq model name |
| `CHUNK_SIZE` | `1000` | Text chunk size (characters) |
| `CHUNK_OVERLAP` | `200` | Overlap between chunks |
| `TOP_K` | `5` | Retrieved chunks per question |
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Local embedding model |
| `UPLOAD_DIR` | `uploads` | PDF upload directory |
| `VECTORSTORE_DIR` | `vectorstore` | FAISS persistence directory |

## API Endpoints

### `GET /`

Serves the single-page frontend.

### `POST /upload`

Upload and index one or more PDFs.

- **Content-Type:** `multipart/form-data`
- **Field name:** `pdfs` (supports multiple files)

**Response (201):**

```json
{
  "message": "Successfully processed 1 PDF(s).",
  "documents": [
    {
      "filename": "report.pdf",
      "documentId": "...",
      "numPages": 12,
      "chunkCount": 45,
      "characterCount": 32000
    }
  ],
  "indexed": true
}
```

### `POST /chat`

Ask a question against indexed documents.

**Body:**

```json
{
  "question": "What is the main conclusion?"
}
```

**Response:**

```json
{
  "answer": "...",
  "citations": [
    {
      "rank": 1,
      "source": "report.pdf",
      "chunkIndex": 3,
      "score": 0.42,
      "excerpt": "..."
    }
  ],
  "sources": ["report.pdf"]
}
```

### `GET /api/status`

Returns indexed document list and index status.

### `GET /api/health`

Health check.

## How It Works

1. **Upload** — PDFs are saved to `uploads/`, text is extracted and split into chunks (LangChain `RecursiveCharacterTextSplitter`).
2. **Embed** — Chunks are embedded locally via Transformers.js (no extra API key).
3. **Store** — Vectors are stored in **FAISS** and persisted under `vectorstore/`. Metadata is recorded in **SQL Server**.
4. **Chat** — Your question is embedded, top-K similar chunks are retrieved, context is sent to **Groq**, and the answer is returned with **citations** (filename, chunk index, excerpt).

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `GROQ_API_KEY is not set` | Copy `.env.example` to `.env` and add your key |
| `canvas` install fails on Node 25 | This fixed build removes `pdf-img-convert`; run clean install again |
| SQL connection errors | Verify SSMS credentials; set `DB_TRUST_SERVER_CERTIFICATE=true` for local dev |
| Empty PDF text | PDF may be scanned images; use OCR-enabled PDFs |
| Slow first upload | Embedding model download + first inference is one-time |

## License

MIT
