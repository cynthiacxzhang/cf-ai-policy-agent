# cf_ai_policy_agent

A regulatory document Q&A agent built on Cloudflare's AI platform. Upload policy documents (EU AI Act, PIPEDA, GDPR, etc.) and chat with an agent that answers questions with **specific clause citations**, maintains full **conversation memory**, and grounds responses in your uploaded text via **RAG**.

Built as part of the Cloudflare AI application assignment.

**Live Demo:** https://cf-ai-policy-agent.cynthia-zhang-2016.workers.dev/

---

## Why this project

This connects directly to real policy work: AI governance advisory (IPC Ontario), privacy law research (TRuST Lab RAG pipelines), and the gap that practitioners face when trying to navigate dense regulatory texts quickly. The agent acts as a precision retrieval layer over documents you actually care about.

---

## Architecture

```
Browser (public/index.html)
   │  WebSocket  ──────────────────────────────────────────┐
   │  POST /api/ingest                                      │
   ▼                                                        ▼
Cloudflare Worker (src/index.ts)                  PolicyChatAgent DO
   │                                             (src/agent.ts)
   │  creates workflow instance                    │  this.sql → conversation history (SQLite)
   ▼                                               │  Vectorize → semantic search (RAG)
IngestionWorkflow (src/workflow.ts)                │  Workers AI Llama 3.3 → answer + cite
   │  chunk text                                   └─────────────────────────────────────
   │  embed with BGE-base (768d)
   └─ upsert to Vectorize index
```

### Components

| Component | Cloudflare Primitive | Purpose |
|---|---|---|
| `PolicyChatAgent` | Durable Object (via Agents SDK) | Stateful chat + RAG per session |
| Conversation history | DO SQLite (`this.sql`) | Persistent memory across reconnects |
| Document embeddings | Vectorize | Semantic search over uploaded policy text |
| LLM | Workers AI — Llama 3.3 70B (FP8) | Answer generation with citations |
| Embeddings model | Workers AI — BGE-base-en-v1.5 | 768-dim vectors for both docs and queries |
| Document ingestion | Cloudflare Workflows | Durable chunking → embedding → upsert pipeline |
| Frontend | Cloudflare Assets (static) | Vanilla JS WebSocket chat + document upload UI |

---

## Running locally

### Prerequisites

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) v4+ (`npm i -g wrangler`)
- A Cloudflare account (free tier works)
- Node 18+

### 1. Clone and install

```bash
git clone <repo-url>
cd cf_ai_policy_agent
npm install
```

### 2. Create the Vectorize index

```bash
wrangler vectorize create policy-docs --dimensions=768 --metric=cosine
```

### 3. Deploy to Cloudflare (recommended for full functionality)

Vectorize and Workflows require a deployed Worker — they are not fully available in local `wrangler dev` mode.

```bash
wrangler deploy
```

Visit the deployed URL (e.g. `https://cf-ai-policy-agent.<your-subdomain>.workers.dev`).

### 4. (Optional) Local dev with remote bindings

```bash
wrangler dev --remote
```

This runs the Worker locally but routes AI/Vectorize/Workflow calls to Cloudflare.

---

## Using the agent

1. **Upload a document** — paste policy text into the sidebar (or click a sample snippet like "EU AI Act excerpt"). Give it a name and click "Index Document". Wait for the green "indexed successfully" confirmation (~10–30 s depending on doc size).

2. **Chat** — type a question in the chat box. The agent will:
   - Embed your question and search the Vectorize index
   - Retrieve the top 5 relevant chunks (filtered by similarity ≥ 0.55)
   - Inject them into the system prompt as cited sources
   - Stream a Llama 3.3 response with `[Source N]` citations

3. **Conversation memory** — history persists in the Durable Object's SQLite. Reconnecting (refresh) resumes your session. Click "Clear history" to start fresh.

### Example questions after loading the EU AI Act sample

- *"What AI practices are explicitly prohibited under Article 5?"*
- *"What makes an AI system 'high-risk' according to the Act?"*
- *"What transparency requirements apply to high-risk AI systems?"*

### Example questions after loading the PIPEDA sample

- *"What is the accountability principle under PIPEDA?"*
- *"How does PIPEDA handle consent for personal information collection?"*
- *"What are an individual's access rights under PIPEDA Principle 9?"*

---

## Project structure

```
cf_ai_policy_agent/
├── src/
│   ├── index.ts        # Worker entry: routing, ingestion API, asset serving
│   ├── agent.ts        # PolicyChatAgent — Durable Object with RAG + chat
│   └── workflow.ts     # IngestionWorkflow — chunk, embed, upsert pipeline
├── public/
│   └── index.html      # Frontend: WebSocket chat + document upload UI
├── wrangler.toml
├── package.json
├── tsconfig.json
├── README.md
└── PROMPTS.md
```

---

## Key design decisions

**Base `Agent` class, not `AIChatAgent`** — gives direct control over the WebSocket protocol and lets us inject RAG context into every message before hitting the LLM, without fighting the AI SDK's message format.

**Vectorize similarity threshold (0.55)** — conservative enough to avoid noisy chunks being injected as context. Tune down to 0.4 if you find relevant content being filtered.

**Workflow for ingestion** — gives durability: if the Worker is interrupted mid-index (large document), the Workflow resumes from the last completed step rather than re-processing from scratch.

**Session per browser tab** — session ID is stored in `sessionStorage`, so each tab gets its own isolated DO instance and conversation history.

---

## Cloudflare services used

- [Workers](https://developers.cloudflare.com/workers/) — main compute layer
- [Agents SDK](https://developers.cloudflare.com/agents/) — Durable Object base class with SQLite and WebSocket management
- [Workers AI](https://developers.cloudflare.com/workers-ai/) — Llama 3.3 70B + BGE embeddings
- [Vectorize](https://developers.cloudflare.com/vectorize/) — vector database for RAG
- [Workflows](https://developers.cloudflare.com/workflows/) — durable document ingestion pipeline
- [Assets](https://developers.cloudflare.com/workers/static-assets/) — static frontend serving
