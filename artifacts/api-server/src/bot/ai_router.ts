/**
 * ai_router.ts — централизованный AI-роутер
 *
 * Порядок провайдеров: Groq (primary, несколько моделей) → Gemini → Grok/xAI
 *
 * При 429/503/ошибке конкретная модель/провайдер помечается «на паузе» на 2 минуты,
 * следующий запрос идёт к следующей модели или провайдеру.
 * Пользователь НИКОГДА не получает молчание из-за лимитов одного провайдера.
 */

import Groq from "groq-sdk";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import OpenAI from "openai";
import { logger } from "../lib/logger";

// ─── Credentials ─────────────────────────────────────────────────────────────

const GROQ_KEY   = process.env["GROQ_API_KEY"]   ?? "";
const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? "";
const GROK_KEY   = process.env["GROK_API_KEY"]   ?? "";

// ─── Provider cooldown tracker ────────────────────────────────────────────────

const COOLDOWN_MS = 2 * 60_000; // 2 минуты

class ProviderCooldown {
  private failedUntil = 0;
  private name: string;

  constructor(name: string) { this.name = name; }

  isAvailable(): boolean {
    return Date.now() > this.failedUntil;
  }

  markFailed(reason?: string): void {
    this.failedUntil = Date.now() + COOLDOWN_MS;
    logger.warn({ provider: this.name, reason, cooldown_s: COOLDOWN_MS / 1000 }, "Provider marked unavailable");
  }

  markOk(): void {
    if (this.failedUntil > 0) {
      logger.info({ provider: this.name }, "Provider recovered");
      this.failedUntil = 0;
    }
  }

  cooldownRemaining(): number {
    return Math.max(0, Math.ceil((this.failedUntil - Date.now()) / 1000));
  }
}

// ─── Groq model pool — пробуем по очереди при rate limit ──────────────────────

const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
  "llama3-70b-8192",
  "mixtral-8x7b-32768",
];

const groqModelCooldowns = new Map<string, ProviderCooldown>(
  GROQ_MODELS.map(m => [m, new ProviderCooldown(`groq:${m}`)]),
);

const geminiCooldown = new ProviderCooldown("gemini");
const grokCooldown   = new ProviderCooldown("grok");

// ─── Clients ──────────────────────────────────────────────────────────────────

const groqClient  = GROQ_KEY   ? new Groq({ apiKey: GROQ_KEY })   : null;
const geminiClient = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;
const grokClient   = GROK_KEY
  ? new OpenAI({ apiKey: GROK_KEY, baseURL: "https://api.x.ai/v1" })
  : null;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIRouterOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  label?: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Главная функция: Groq (ротация моделей) → Gemini → Grok/xAI
 * Никогда не молчит — всегда либо ответ, либо понятная ошибка.
 */
export async function getAIResponse(
  messages: AIMessage[],
  opts: AIRouterOptions = {}
): Promise<string> {
  const label = opts.label ?? "ai_router";

  // ── 1. Groq — перебираем модели по очереди ───────────────────────────────
  if (groqClient) {
    for (const model of GROQ_MODELS) {
      const cd = groqModelCooldowns.get(model)!;
      if (!cd.isAvailable()) continue;
      try {
        const result = await callGroq(groqClient, model, messages, opts);
        cd.markOk();
        logger.debug({ label, provider: "groq", model }, "AI response via Groq");
        return result;
      } catch (err) {
        const reason = classifyError(err);
        logger.warn({ label, model, reason }, "Groq model failed, trying next");
        cd.markFailed(reason);
        // При 401/auth сразу прекращаем пробовать другие модели Groq
        if (reason === "auth_error") break;
      }
    }
  }

  // ── 2. Gemini ─────────────────────────────────────────────────────────────
  if (geminiClient && geminiCooldown.isAvailable()) {
    try {
      const result = await callGemini(geminiClient, messages, opts);
      geminiCooldown.markOk();
      logger.debug({ label, provider: "gemini" }, "AI response via Gemini");
      return result;
    } catch (err) {
      const reason = classifyError(err);
      logger.warn({ label, reason }, "Gemini failed");
      geminiCooldown.markFailed(reason);
    }
  }

  // ── 3. Grok/xAI ───────────────────────────────────────────────────────────
  if (grokClient && grokCooldown.isAvailable()) {
    try {
      const result = await callGrok(grokClient, messages, opts);
      grokCooldown.markOk();
      logger.debug({ label, provider: "grok" }, "AI response via Grok");
      return result;
    } catch (err) {
      const reason = classifyError(err);
      logger.warn({ label, reason }, "Grok failed");
      grokCooldown.markFailed(reason);
    }
  }

  // ── 4. Последняя попытка — наименее остывший Groq-провайдер ───────────────
  if (groqClient) {
    const available = [...groqModelCooldowns.entries()]
      .sort(([, a], [, b]) => a.cooldownRemaining() - b.cooldownRemaining());
    for (const [model] of available.slice(0, 2)) {
      try {
        const result = await callGroq(groqClient, model, messages, opts);
        groqModelCooldowns.get(model)!.markOk();
        logger.warn({ label, model }, "AI response via Groq (force retry)");
        return result;
      } catch { /* continue */ }
    }
  }

  // ── 5. Gemini форс ────────────────────────────────────────────────────────
  if (geminiClient) {
    try {
      const result = await callGemini(geminiClient, messages, opts);
      geminiCooldown.markOk();
      return result;
    } catch { /* fall through */ }
  }

  // ── 6. Grok форс ─────────────────────────────────────────────────────────
  if (grokClient) {
    try {
      const result = await callGrok(grokClient, messages, opts);
      grokCooldown.markOk();
      return result;
    } catch { /* fall through */ }
  }

  throw new Error(`[ai_router] All providers unavailable for label="${label}"`);
}

/**
 * Обёртка для получения JSON-ответа.
 */
export async function getJSONResponse<T = Record<string, unknown>>(
  messages: AIMessage[],
  opts: AIRouterOptions = {}
): Promise<T> {
  const text = await getAIResponse(messages, { ...opts, jsonMode: true });
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(clean) as T;
}

/**
 * Статус провайдеров — для мониторинга / /status.
 */
export function getProviderStatus(): {
  groq:   { available: boolean; availableModels: string[]; configured: boolean };
  gemini: { available: boolean; cooldownRemaining: number; configured: boolean };
  grok:   { available: boolean; cooldownRemaining: number; configured: boolean };
} {
  const availableGroqModels = GROQ_MODELS.filter(m => groqModelCooldowns.get(m)!.isAvailable());
  return {
    groq: {
      available:       availableGroqModels.length > 0,
      availableModels: availableGroqModels,
      configured:      !!groqClient,
    },
    gemini: {
      available:         geminiCooldown.isAvailable(),
      cooldownRemaining: geminiCooldown.cooldownRemaining(),
      configured:        !!geminiClient,
    },
    grok: {
      available:         grokCooldown.isAvailable(),
      cooldownRemaining: grokCooldown.cooldownRemaining(),
      configured:        !!grokClient,
    },
  };
}

// ─── Groq call ────────────────────────────────────────────────────────────────

async function callGroq(
  client: Groq,
  model: string,
  messages: AIMessage[],
  opts: AIRouterOptions
): Promise<string> {
  const params: Groq.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: messages as Groq.Chat.ChatCompletionMessageParam[],
    max_tokens:  opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.85,
  };
  if (opts.jsonMode) {
    params.response_format = { type: "json_object" };
  }
  const completion = await client.chat.completions.create(params);
  const text = completion.choices[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("Groq returned empty response");
  return text;
}

// ─── Gemini call ─────────────────────────────────────────────────────────────

async function callGemini(
  client: GoogleGenerativeAI,
  messages: AIMessage[],
  opts: AIRouterOptions
): Promise<string> {
  const systemMsg = messages.find(m => m.role === "system");
  const conversationMsgs = messages.filter(m => m.role !== "system");

  const systemText = [
    systemMsg?.content ?? "",
    opts.jsonMode ? "\n\nОтвечай ТОЛЬКО валидным JSON без markdown-обёртки." : "",
  ].join("").trim();

  const model = client.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemText || undefined,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 512,
      temperature:     opts.temperature ?? 0.85,
    },
  });

  const history = conversationMsgs.slice(0, -1).map(m => ({
    role:  m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));
  const lastMsg = conversationMsgs[conversationMsgs.length - 1];
  if (!lastMsg) throw new Error("No user message");

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(lastMsg.content);
  const text = result.response.text().trim();
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

// ─── Grok/xAI call ───────────────────────────────────────────────────────────

async function callGrok(
  client: OpenAI,
  messages: AIMessage[],
  opts: AIRouterOptions
): Promise<string> {
  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model:       "grok-3-mini",
    messages:    messages as OpenAI.Chat.ChatCompletionMessageParam[],
    max_tokens:  opts.maxTokens ?? 512,
    temperature: opts.temperature ?? 0.85,
  };
  if (opts.jsonMode) {
    params.response_format = { type: "json_object" };
  }
  const completion = await client.chat.completions.create(params);
  const text = completion.choices[0]?.message?.content?.trim() ?? "";
  if (!text) throw new Error("Grok returned empty response");
  return text;
}

// ─── Error classifier ─────────────────────────────────────────────────────────

function classifyError(err: unknown): string {
  const msg = String(err).toLowerCase();
  if (msg.includes("429") || msg.includes("rate") || msg.includes("quota")) return "rate_limit";
  if (msg.includes("503") || msg.includes("overload") || msg.includes("unavailable")) return "overloaded";
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("api key")) return "auth_error";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  return "unknown";
}
