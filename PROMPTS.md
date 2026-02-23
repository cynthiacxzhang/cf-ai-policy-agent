# AI Prompts Used

This file documents the prompts used with Claude (claude-sonnet-4-6 via Claude Code CLI) during development of this project.

---

## Session 1 — Architecture design

**Prompt (user):**
> My recommendation for what to build:
> Given your background (AI literacy, policymaker tooling, RAG at TRuST), the strongest project that's also fast to ship and directly maps to your interests:
> A regulatory document Q&A agent — you upload or point to a policy document (e.g. EU AI Act, PIPEDA), and chat with an agent that answers questions, maintains conversation memory, and cites specific clauses. Built entirely on Cloudflare:
> LLM: Llama 3.3 on Workers AI
> Memory/state: Durable Objects holding conversation history + Vectorize for document embeddings (RAG)
> Workflow: Cloudflare Workflow for document ingestion (chunk, embed, store)
> User input: WebSocket chat via Workers + Pages frontend

**What was generated:** Full architecture plan, component mapping, and decision to use the base `Agent` class for direct protocol control.

---

## Session 2 — Platform research

**Prompts used to research Cloudflare APIs:**

1. *"What is this platform? What tools, APIs, and capabilities does it offer for building AI applications? List key features, SDKs, and examples."* → fetched `agents.cloudflare.com`

2. *"Give me the complete Agent class API - all methods, properties, constructor signature, handlers, state management, and TypeScript types."* → fetched `developers.cloudflare.com/agents/api-reference/agents-api/`

3. *"Give me the complete code for the RAG tutorial - wrangler.toml bindings, the Worker code (embedding generation, Vectorize insert/query, AI chat), and any TypeScript types."* → fetched `developers.cloudflare.com/workers-ai/guides/tutorials/build-a-retrieval-augmented-generation-ai/`

4. *"Show the complete wrangler.toml configuration for Cloudflare Agents - how to configure the agent binding, AI binding, Vectorize binding, and Workflows."* → fetched `developers.cloudflare.com/agents/api-reference/configuration/`

5. *"Extract: 1) The complete AIChatAgent class API 2) Complete wrangler.toml example with all bindings 3) The workers-ai-provider package - how to create a provider and call Llama 3.3."* → fetched `developers.cloudflare.com/agents/llms-full.txt`

---

## Session 3 — Full implementation

**Prompt (user to Claude Code):**
> [the assignment description above + architecture recommendation]
> [Claude Code was then instructed to build the full project]

**What was generated:**

- `package.json` — with correct dependency versions for `agents@0.5.0`, `ai@^6.0.0`, `workers-ai-provider@^3.1.1`
- `wrangler.toml` — full Cloudflare bindings: AI, Vectorize, Durable Objects, Workflows, Assets
- `tsconfig.json` — Workers-compatible TypeScript config with `skipLibCheck`
- `src/agent.ts` — `PolicyChatAgent extends Agent<Env>` with:
  - SQLite conversation history via `this.sql`
  - RAG: BGE-base embedding → Vectorize query → context injection
  - Streaming Llama 3.3 via `workers-ai-provider` + Vercel AI SDK `streamText`
  - WebSocket message protocol: `chat` / `clear` / `get_history` / `chunk` / `done`
- `src/workflow.ts` — `IngestionWorkflow extends WorkflowEntrypoint` with:
  - Sentence-boundary-aware text chunking (800 chars, 150 overlap)
  - Batch embedding (5 chunks per Workers AI call)
  - Vectorize upsert with metadata (text, docName, chunkIndex, docId)
- `src/index.ts` — Worker entry point with:
  - `POST /api/ingest` and `GET /api/workflow/:id` REST endpoints
  - `routeAgentRequest` for Agents SDK routing
  - Static asset serving via `env.ASSETS`
- `public/index.html` — full single-page chat UI with:
  - WebSocket client with auto-reconnect and session persistence
  - Document upload form with ingestion status polling
  - Streaming message rendering with typing indicator
  - Conversation history restoration on reconnect
  - Pre-loaded EU AI Act and PIPEDA sample snippets

**Debugging prompts (version resolution):**
- *"agents@0.5.0 requires ai@^6.0.0 but I specified ai@^4.3.16 — fix the dependency versions"*
- *"workers-ai-provider model string type error — cast CHAT_MODEL to bypass strict TextGenerationModels type"*
- *"skipLibCheck needed for node module type conflicts between ai SDK and Cloudflare Workers types"*

---

## System prompt used with LLM (in agent.ts)

The `buildSystemPrompt()` function in `src/agent.ts` generates this at runtime:

```
You are a regulatory policy expert assistant. You help users understand policy
documents such as the EU AI Act, PIPEDA, GDPR, CCPA, and other regulatory frameworks.

When answering:
- Cite specific articles, clauses, or sections when referencing document text.
- Use [Source N] notation to reference retrieved passages.
- Distinguish clearly between information from uploaded documents and general knowledge.
- Be precise with legal/regulatory language — avoid paraphrasing in ways that change meaning.
- If a question is not covered by the uploaded documents, state that explicitly before drawing
  on general knowledge.

[Relevant excerpts from loaded policy documents — injected at runtime from Vectorize]
```
