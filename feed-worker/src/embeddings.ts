import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Runs fully on-CPU via ONNX Runtime — no external embedding API, no GPU
// required. Model weights (~90MB) are baked into the Docker image at build
// time (see Dockerfile's warmup step) into this fixed cache dir, so the
// running container never needs network access to embed a post; every
// embedding call is local inference only.
env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR ?? "./.cache/models";

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    // If this rejects (e.g. a transient disk read error loading the ~90MB
    // model), clear it back to undefined so the *next* call tries loading
    // again instead of permanently reusing the same rejected promise —
    // otherwise one bad load wedges this process into failing every future
    // job for its entire remaining lifetime, invisibly (the health check is
    // liveness-only and would keep reporting this instance as healthy).
    pipelinePromise = (pipeline("feature-extraction", MODEL_NAME) as Promise<FeatureExtractionPipeline>).catch(
      (error: unknown) => {
        pipelinePromise = undefined;
        throw error;
      }
    );
  }
  return pipelinePromise;
}

/** Loads (and caches) the model eagerly so the first real job isn't the one
 * paying the cold-start cost. */
export async function warmUpEmbeddings(): Promise<void> {
  await getPipeline();
}

export async function embedText(text: string): Promise<number[] | null> {
  const extractor = await getPipeline();
  const trimmed = text.trim();
  // Empty/media-only posts have no text to embed. Never index an all-zero
  // vector as a cosine-search candidate (norm 0 = undefined similarity);
  // return null so the caller skips search indexing but still fans out.
  if (trimmed.length === 0) {
    return null;
  }

  const output = await extractor(trimmed, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}
