/**
 * Anime image generation via Hugging Face Inference API
 *
 * Model priority (best quality first):
 *   1. cagliostrolab/animagine-xl-3.1  — SDXL-based, state-of-the-art anime
 *   2. Lykon/dreamshaper-xl-1-0        — DreamShaper XL, excellent versatility
 *   3. stablediffusionapi/anything-v5  — Anything V5, proven anime quality
 */

import { logger } from "../lib/logger";

const HF_TOKEN = process.env["HF_TOKEN"] ?? "";

// ─── Model definitions ────────────────────────────────────────────────────────

interface HfModel {
  id: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  isXL: boolean;
}

const MODELS: HfModel[] = [
  {
    id: "cagliostrolab/animagine-xl-3.1",
    width: 832,
    height: 1216,
    steps: 35,
    guidance: 7.0,
    isXL: true,
  },
  {
    id: "Lykon/dreamshaper-xl-1-0",
    width: 832,
    height: 1216,
    steps: 30,
    guidance: 7.0,
    isXL: true,
  },
  {
    id: "stablediffusionapi/anything-v5",
    width: 512,
    height: 768,
    steps: 30,
    guidance: 7.5,
    isXL: false,
  },
];

// ─── Prompt quality suffixes ──────────────────────────────────────────────────

/** Animagine XL 3.1 / SDXL-style quality tags */
const XL_QUALITY_SUFFIX =
  "masterpiece, best quality, very aesthetic, absurdres, highres, " +
  "perfect face, detailed eyes, sharp focus, vibrant colors, " +
  "professional anime illustration";

/** SD 1.5-style quality tags */
const SD15_QUALITY_SUFFIX =
  "masterpiece, best quality, highres, 8k, anime style, " +
  "detailed face, sharp focus, vibrant colors, studio lighting";

/** Negative prompt — works for both XL and SD 1.5 */
const NEGATIVE_PROMPT =
  "lowres, bad anatomy, bad hands, extra fingers, missing fingers, " +
  "extra limbs, fewer digits, cropped, worst quality, low quality, " +
  "normal quality, jpeg artifacts, signature, watermark, username, blurry, " +
  "deformed, disfigured, mutation, ugly, duplicate, morbid, mutilated, " +
  "out of frame, extra, text, error, (bad proportions:1.4)";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WaifuResult {
  imageBuffer: Buffer;
  modelUsed: string;
  prompt: string;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Generates an anime image using HF Inference API.
 * Automatically waits during model warm-up (503) and retries.
 * Falls through all models before giving up.
 */
export async function generateWaifu(userPrompt: string): Promise<WaifuResult> {
  if (!HF_TOKEN) throw new Error("HF_TOKEN not set");

  for (const model of MODELS) {
    const qualitySuffix = model.isXL ? XL_QUALITY_SUFFIX : SD15_QUALITY_SUFFIX;
    const enrichedPrompt = `${userPrompt.trim()}, ${qualitySuffix}`;

    try {
      const buf = await callHfApi(model, enrichedPrompt);
      logger.info({ model: model.id, prompt: enrichedPrompt }, "Waifu generated");
      return { imageBuffer: buf, modelUsed: model.id, prompt: enrichedPrompt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ model: model.id, err: msg }, "Waifu model failed, trying next");
    }
  }

  throw new Error("All anime models unavailable");
}

// ─── HF API call with warm-up retry ──────────────────────────────────────────

async function callHfApi(model: HfModel, prompt: string): Promise<Buffer> {
  const url = `https://api-inference.huggingface.co/models/${model.id}`;
  const MAX_ATTEMPTS = 4;
  const WARMUP_WAIT_MS = 20_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
        "x-wait-for-model": "true",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          negative_prompt:     NEGATIVE_PROMPT,
          num_inference_steps: model.steps,
          guidance_scale:      model.guidance,
          width:               model.width,
          height:              model.height,
        },
        options: {
          wait_for_model: true,
          use_cache: false,
        },
      }),
    });

    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    const bodyText = await res.text().catch(() => "");

    if (res.status === 503) {
      logger.info({ model: model.id, attempt }, `Warming up (503), waiting ${WARMUP_WAIT_MS / 1000}s…`);
      if (attempt < MAX_ATTEMPTS) { await sleep(WARMUP_WAIT_MS); continue; }
      throw new Error(`Model still loading after ${MAX_ATTEMPTS} attempts`);
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "30", 10);
      logger.warn({ model: model.id }, `Rate limited, waiting ${retryAfter}s`);
      if (attempt < MAX_ATTEMPTS) { await sleep(retryAfter * 1000); continue; }
      throw new Error("Rate limit exceeded");
    }

    throw new Error(`HF API ${res.status}: ${bodyText.slice(0, 200)}`);
  }

  throw new Error("Max attempts exceeded");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
