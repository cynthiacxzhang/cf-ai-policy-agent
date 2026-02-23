import { routeAgentRequest } from "agents";
import { PolicyChatAgent } from "./agent";
import type { Env } from "./agent";
import { IngestionWorkflow } from "./workflow";

// Re-export Durable Object and Workflow classes — required by Wrangler
export { PolicyChatAgent, IngestionWorkflow };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

function chunkText(raw: string): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    if (end < text.length) {
      const sentenceEnd = text.lastIndexOf(". ", end);
      if (sentenceEnd > start + CHUNK_SIZE / 2) {
        end = sentenceEnd + 1;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);

    if (end >= text.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }

  return chunks;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Pre-flight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ── POST /api/ingest ─────────────────────────────────────────────────────
    if (url.pathname === "/api/ingest" && request.method === "POST") {
      try {
        const body = (await request.json()) as { text?: string; docName?: string };
        if (!body.text || !body.docName) {
          return Response.json(
            { error: "Both 'text' and 'docName' are required." },
            { status: 400, headers: CORS },
          );
        }
        const chunks = chunkText(body.text);
        const docId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const instance = await env.INGESTION_WORKFLOW.create({
          params: { chunks, docName: body.docName, docId },
        });
        return Response.json({ id: instance.id, status: "started" }, { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500, headers: CORS });
      }
    }

    // ── GET /api/workflow/:id ────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/workflow/") && request.method === "GET") {
      try {
        const id = url.pathname.split("/").pop()!;
        const instance = await env.INGESTION_WORKFLOW.get(id);
        const status = await instance.status();
        return Response.json(status, { headers: CORS });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 404, headers: CORS });
      }
    }

    // ── Agent routing (WebSocket + DO HTTP) ──────────────────────────────────
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // ── Static assets (public/) ──────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
