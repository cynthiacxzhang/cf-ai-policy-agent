import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export interface IngestionParams {
  chunks: string[];
  docName: string;
  docId: string;
}

interface IngestionEnv {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
}

interface EmbedResult {
  data: number[][];
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_BATCH = 5; // chunks per Workers AI call

export class IngestionWorkflow extends WorkflowEntrypoint<IngestionEnv, IngestionParams> {
  async run(event: WorkflowEvent<IngestionParams>, step: WorkflowStep) {
    const { chunks, docName, docId } = event.payload;

    // Process chunks in batches to stay within AI rate limits
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);

      await step.do(`embed-and-store-batch-${i}`, async () => {
        const embResult = (await this.env.AI.run(
          EMBED_MODEL as Parameters<Ai["run"]>[0],
          { text: batch },
        )) as EmbedResult;

        const vectors = batch.map((chunk, j) => ({
          id: `${docId}-chunk-${i + j}`,
          values: embResult.data[j],
          metadata: {
            text: chunk,
            docName,
            chunkIndex: i + j,
            docId,
          },
        }));

        await this.env.VECTORIZE.upsert(vectors);
      });
    }

    return { docId, chunkCount: chunks.length };
  }
}
