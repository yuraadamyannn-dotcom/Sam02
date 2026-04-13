/**
 * Waifu / anime image generation via Hugging Face Inference API
 * Models: Linaqruf/anything-v5.0  (primary)
 *         WarriorMama777/OrangeMixs (fallback)
 */

import { logger } from "../lib/logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const HF_TOKEN = process.env.HF_TOKEN ?? "";

const MODELS = [
  "Linaqruf/anything-v5.0",
  "WarriorMama777/OrangeMixs",
] as const;

/** Суффиксы, которые всегда добавляются к промту для качества */
const QUALITY_SUFFIX =
  "masterpiece, best quality, highres, 8k, anime style, detailed face, " +
  "sharp focus, vibrant colors, studio lighting";

/** Негативный промт — убираем мусор */
const NEGATIVE_PROMPT =
  "lowres, bad anatomy, bad hands, text, error, missing fingers, " +
  "extra digit, fewer digits, cropped, worst quality, low quality, " +
  "normal quality, jpeg artifacts, signature, watermark, username, blurry";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WaifuResult {
  imageBuffer: Buffer;
  modelUsed: string;
  prompt: string;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Генерирует аниме-изображение через HF Inference API.
 * Автоматически ждёт, если модель «прогревается» (503).
 * При ошибке на первой модели переключается на запасную.
 */
export async function generateWaifu(userPrompt: string): Promise<WaifuResult> {
  if (!HF_TOKEN) throw new Error("HF_TOKEN не задан в переменных окружения");

  const enrichedPrompt = `${userPrompt.trim()}, ${QUALITY_SUFFIX}`;

  for (const model of MODELS) {
    try {
      const buf = await callHfApi(model, enrichedPrompt);
      logger.info({ model, prompt: enrichedPrompt }, "Waifu generated");
      return { imageBuffer: buf, modelUsed: model, prompt: enrichedPrompt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ model, err: msg }, "Waifu model failed, trying fallback");
      // Если это последняя модель — пробрасываем ошибку
      if (model === MODELS[MODELS.length - 1]) throw err;
    }
  }

  throw new Error("Все модели недоступны");
}

// ─── HF API call with 503 retry ───────────────────────────────────────────────

async function callHfApi(model: string, prompt: string): Promise<Buffer> {
  const url = `https://api-inference.huggingface.co/models/${model}`;

  const MAX_ATTEMPTS = 5;
  const WARMUP_WAIT_MS = 15_000; // 15 секунд между попытками при 503

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
          negative_prompt: NEGATIVE_PROMPT,
          num_inference_steps: 30,
          guidance_scale: 7.5,
          width: 512,
          height: 768,
        },
        options: {
          wait_for_model: true,
          use_cache: false,
        },
      }),
    });

    // Успех — возвращаем байты изображения
    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    const bodyText = await res.text().catch(() => "");

    // 503 — модель грузится, ждём
    if (res.status === 503) {
      logger.info({ model, attempt }, `Model warming up (503), waiting ${WARMUP_WAIT_MS / 1000}s…`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(WARMUP_WAIT_MS);
        continue;
      }
      throw new Error(`Model still loading after ${MAX_ATTEMPTS} attempts`);
    }

    // 429 — rate limit
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "30", 10);
      logger.warn({ model }, `Rate limited, waiting ${retryAfter}s`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new Error("Rate limit exceeded");
    }

    // Другая ошибка
    throw new Error(`HF API ${res.status}: ${bodyText.slice(0, 200)}`);
  }

  throw new Error("Max attempts exceeded");
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
