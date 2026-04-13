/**
 * ai_router.ts — централизованный AI-роутер
 *
 * Порядок: Gemini (primary) → Grok / xAI (fallback)
 * При 429 / 503 / любой ошибке провайдер помечается «на паузе» на 1 минуту,
 * все запросы идут на второй. Когда пауза истекает — снова пробуем оба.
 * Пользователь никогда не получает молчание из-за лимитов одного API.
 */

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import OpenAI from "openai";
import { logger } from "../lib/logger";

// ─── Credentials ─────────────────────────────────────────────────────────────

const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? "";
const GROK_KEY   = process.env["GROK_API_KEY"]   ?? "";

// ─── Provider cooldown tracker ────────────────────────────────────────────────

const COOLDOWN_MS = 60_000; // 1 минута

class ProviderCooldown {
  private failedUntil = 0;
  private name: string;

  constructor(name: string) { this.name = name; }

  isAvailable(): boolean {
    const available = Date.now() > this.failedUntil;
    if (!available) {
      const remaining = Math.ceil((this.failedUntil - Date.now()) / 1000);
      logger.debug({ provider: this.name, cooldown_remaining_s: remaining }, "Provider on cooldown");
    }
    return available;
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

  /** Секунд осталось на паузе (0 если доступен) */
  cooldownRemaining(): number {
    return Math.max(0, Math.ceil((this.failedUntil - Date.now()) / 1000));
  }
}

const geminiCooldown = new ProviderCooldown("gemini");
const grokCooldown   = new ProviderCooldown("grok");

// ─── Clients ──────────────────────────────────────────────────────────────────

const geminiClient = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const grokClient = GROK_KEY
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
  /** Если true — просим модель вернуть чистый JSON */
  jsonMode?: boolean;
  /** Метка для логов */
  label?: string;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Главная функция: отправляет запрос через Gemini или Grok,
 * с автоматическим переключением при ошибке.
 * Никогда не молчит — если оба провайдера временно недоступны,
 * пробует тот, у которого меньше осталось пауза.
 */
export async function getAIResponse(
  messages: AIMessage[],
  opts: AIRouterOptions = {}
): Promise<string> {
  const label = opts.label ?? "ai_router";

  // ── Попытка 1: Gemini ─────────────────────────────────────────────────────
  if (geminiClient && geminiCooldown.isAvailable()) {
    try {
      const result = await callGemini(geminiClient, messages, opts);
      geminiCooldown.markOk();
      logger.debug({ label, provider: "gemini" }, "AI response via Gemini");
      return result;
    } catch (err) {
      const reason = classifyError(err);
      logger.warn({ label, err: String(err), reason }, "Gemini failed");
      geminiCooldown.markFailed(reason);
    }
  }

  // ── Попытка 2: Grok ───────────────────────────────────────────────────────
  if (grokClient && grokCooldown.isAvailable()) {
    try {
      const result = await callGrok(grokClient, messages, opts);
      grokCooldown.markOk();
      logger.debug({ label, provider: "grok" }, "AI response via Grok");
      return result;
    } catch (err) {
      const reason = classifyError(err);
      logger.warn({ label, err: String(err), reason }, "Grok failed");
      grokCooldown.markFailed(reason);
    }
  }

  // ── Оба на паузе — берём того, у кого пауза меньше и пробуем принудительно
  logger.error({ label }, "Both providers on cooldown — forcing least-expired");
  const useGeminiFirst = geminiCooldown.cooldownRemaining() <= grokCooldown.cooldownRemaining();

  if (useGeminiFirst && geminiClient) {
    try {
      const result = await callGemini(geminiClient, messages, opts);
      geminiCooldown.markOk();
      return result;
    } catch { /* fall through to Grok */ }
  }

  if (grokClient) {
    try {
      const result = await callGrok(grokClient, messages, opts);
      grokCooldown.markOk();
      return result;
    } catch { /* fall through */ }
  }

  // Последний шанс — Gemini даже если нет клиента → явная ошибка
  throw new Error(`[ai_router] All providers unavailable for label="${label}"`);
}

/**
 * Обёртка для получения JSON-ответа с автоматическим парсингом.
 */
export async function getJSONResponse<T = Record<string, unknown>>(
  messages: AIMessage[],
  opts: AIRouterOptions = {}
): Promise<T> {
  const text = await getAIResponse(messages, { ...opts, jsonMode: true });
  // Убираем markdown-обёртку ```json ... ```
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(clean) as T;
}

/**
 * Статус провайдеров — для мониторинга / /status команды
 */
export function getProviderStatus(): {
  gemini: { available: boolean; cooldownRemaining: number; configured: boolean };
  grok:   { available: boolean; cooldownRemaining: number; configured: boolean };
} {
  return {
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

// ─── Gemini call ─────────────────────────────────────────────────────────────

async function callGemini(
  client: GoogleGenerativeAI,
  messages: AIMessage[],
  opts: AIRouterOptions
): Promise<string> {
  // Извлекаем system prompt (Gemini принимает его отдельно)
  const systemMsg = messages.find(m => m.role === "system");
  const conversationMsgs = messages.filter(m => m.role !== "system");

  // Если jsonMode — добавляем инструкцию в system prompt
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

  // Конвертируем в формат Gemini: role "user"/"model"
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

// ─── Grok call ────────────────────────────────────────────────────────────────

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
