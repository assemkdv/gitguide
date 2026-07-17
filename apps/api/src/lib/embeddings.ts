import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

// Groq's SDK declares an `embeddings` resource in its TypeScript types, but the model
// it references (`nomic-embed-text-v1_5`) 404s on the live API — confirmed directly
// against api.groq.com/openai/v1/models and /embeddings, neither of which serve any
// embedding model for this account. Groq stays the backend for chat completions
// (repo-summary.ts, ask-repo.ts's answer generation); embeddings run locally instead,
// via a small (~25MB quantized) sentence-embedding model loaded in-process — no new API
// key/secret, no per-call cost, no external rate limit. The trade-off is a real one and
// worth stating plainly: this is a native ONNX runtime dependency (like the local-HNSW
// option rejected in the vector-store comparison) and the model weights get downloaded
// from Hugging Face on first use, then cached — on Render's ephemeral filesystem that
// means a fresh download on every cold start/redeploy unless the cache is baked into
// the build image, which is a real operational follow-up, not solved here.
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    // onnxruntime-node's default CPU memory arena never releases memory back to the OS —
    // it retains the high-water mark of every allocation it's ever made for the life of
    // the process, so RSS creeps upward (and can spike into the GBs on a single large
    // batch) across the many sequential embedTexts() calls a repo indexing run makes.
    // Disabling it makes ORT malloc/free per tensor instead, which measured flat at
    // ~200MB regardless of batch size — comfortably inside Render's 512MB free tier,
    // versus 2GB+ with the arena on. Fixed weight-loading cost aside, this is a fixed
    // ONNX-level toggle, not an architecture change.
    extractorPromise = pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      session_options: { enableCpuMemArena: false, enableMemPattern: false },
    }) as Promise<FeatureExtractionPipeline>;
  }
  return extractorPromise;
}

/** Batched, mean-pooled, L2-normalized sentence embeddings (384-dim). Normalized output
 * means cosine similarity and dot product are equivalent — vector-store.ts still does
 * the full cosine computation rather than assuming this, so it stays correct even if
 * the model or normalization setting ever changes. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const rows = output.tolist() as number[][];
  return rows.map((row) => Float32Array.from(row));
}

export async function embedText(text: string): Promise<Float32Array> {
  const [embedding] = await embedTexts([text]);
  return embedding;
}
