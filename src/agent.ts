import { Agent } from "agents";

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  INGESTION_WORKFLOW: Workflow;
  PolicyChatAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface IncomingMessage {
  type: "chat" | "clear" | "get_history";
  content?: string;
}

interface DbRow {
  role: string;
  content: string;
}

interface EmbedResult {
  data: number[][];
}

interface AiStreamChunk {
  response?: string;
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MIN_SIMILARITY = 0.55;
const MAX_HISTORY = 20;

export class PolicyChatAgent extends Agent<Env> {
  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT    NOT NULL,
        content TEXT NOT NULL,
        ts   INTEGER NOT NULL
      )
    `;
  }

  async onMessage(connection: any, raw: string) {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(raw) as IncomingMessage;
    } catch {
      connection.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (msg.type === "get_history") {
      const rows = [
        ...this.sql<DbRow>`
          SELECT role, content FROM messages ORDER BY ts ASC LIMIT 50
        `,
      ];
      connection.send(JSON.stringify({ type: "history", messages: rows }));
      return;
    }

    if (msg.type === "clear") {
      this.sql`DELETE FROM messages`;
      connection.send(JSON.stringify({ type: "cleared" }));
      return;
    }

    if (msg.type === "chat" && msg.content) {
      await this.handleChat(connection, msg.content);
    }
  }

  private async handleChat(connection: any, userMessage: string) {
    // Persist user message
    this.sql`
      INSERT INTO messages (role, content, ts) VALUES ('user', ${userMessage}, ${Date.now()})
    `;

    // RAG: embed query → search Vectorize → build context
    let context = "";
    try {
      const embResult = (await this.env.AI.run(EMBED_MODEL as Parameters<Ai["run"]>[0], {
        text: [userMessage],
      })) as EmbedResult;

      if (embResult.data?.[0]) {
        const results = await this.env.VECTORIZE.query(embResult.data[0], {
          topK: 5,
          returnMetadata: "all",
        });

        const relevant = (results.matches ?? [])
          .filter((m) => m.score >= MIN_SIMILARITY)
          .map((m, i) => {
            const meta = m.metadata as Record<string, string> | undefined;
            return (
              `[Source ${i + 1} — ${meta?.docName ?? "Document"}, ` +
              `Chunk ${meta?.chunkIndex ?? "?"}]\n${meta?.text ?? ""}`
            );
          });

        if (relevant.length > 0) {
          context =
            "Relevant excerpts from loaded policy documents:\n\n" +
            relevant.join("\n\n---\n\n");
        }
      }
    } catch (e) {
      console.error("RAG lookup failed:", e);
    }

    // Retrieve recent conversation history
    const history = [
      ...this.sql<DbRow>`
        SELECT role, content FROM messages ORDER BY ts ASC LIMIT ${MAX_HISTORY}
      `,
    ];

    const systemPrompt = buildSystemPrompt(context);

    // Build messages array for Workers AI
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...history.map((r) => ({ role: r.role, content: r.content })),
    ];

    let assistantReply = "";
    try {
      const stream = (await this.env.AI.run(
        CHAT_MODEL as Parameters<Ai["run"]>[0],
        { messages, stream: true } as Parameters<Ai["run"]>[1],
      )) as ReadableStream;

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (trimmed.startsWith("data: ")) {
              try {
                const chunk = JSON.parse(trimmed.slice(6)) as AiStreamChunk;
                const text = chunk.response ?? "";
                if (text) {
                  assistantReply += text;
                  connection.send(JSON.stringify({ type: "chunk", content: text }));
                }
              } catch {
                // skip malformed SSE lines
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (e) {
      console.error("LLM error:", e);
      connection.send(JSON.stringify({ type: "error", error: "LLM request failed" }));
      return;
    }

    // Persist assistant reply
    this.sql`
      INSERT INTO messages (role, content, ts) VALUES ('assistant', ${assistantReply}, ${Date.now()})
    `;
    connection.send(JSON.stringify({ type: "done" }));
  }
}

function buildSystemPrompt(context: string): string {
  const docSection = context
    ? context
    : "No policy documents have been uploaded yet. Answer from your general knowledge " +
      "about regulatory and policy frameworks, and note this limitation to the user.";

  return `You are a regulatory policy expert assistant. You help users understand policy \
documents such as the EU AI Act, PIPEDA, GDPR, CCPA, and other regulatory frameworks.

When answering:
- Cite specific articles, clauses, or sections when referencing document text.
- Use [Source N] notation to reference retrieved passages.
- Distinguish clearly between information from uploaded documents and general knowledge.
- Be precise with legal/regulatory language — avoid paraphrasing in ways that change meaning.
- If a question is not covered by the uploaded documents, state that explicitly before drawing \
on general knowledge.

${docSection}`;
}
