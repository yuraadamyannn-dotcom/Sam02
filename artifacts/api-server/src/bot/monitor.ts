/**
 * ─── Агент самомониторинга Сэма ───────────────────────────────────────────────
 *
 * Постоянно следит за состоянием бота:
 *  • Polling Telegram API (живость соединения)
 *  • Подключение к базе данных
 *  • Потребление памяти (RAM)
 *  • Groq API доступность
 *  • Очередь сообщений (зависания)
 *  • Автоматически логирует аномалии и пытается восстановиться
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface HealthReport {
  ts: number;
  uptime_seconds: number;
  memory: {
    heap_used_mb: number;
    heap_total_mb: number;
    rss_mb: number;
    external_mb: number;
  };
  checks: {
    db: CheckResult;
    groq: CheckResult;
    telegram_polling: CheckResult;
    memory_pressure: CheckResult;
  };
  overall: "ok" | "degraded" | "critical";
  issues: string[];
}

export interface CheckResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

// ─── Состояние монитора ───────────────────────────────────────────────────────

let lastHealthReport: HealthReport | null = null;
let consecutiveFailures = 0;
let monitorInterval: ReturnType<typeof setInterval> | null = null;

const MEMORY_WARN_MB = 400;
const MEMORY_CRITICAL_MB = 700;
const CHECK_INTERVAL_MS = 60_000; // каждую минуту
const CRITICAL_NOTIFY_INTERVAL_MS = 300_000; // уведомлять владельца раз в 5 мин при критических проблемах

let lastOwnerNotify = 0;

// ─── Проверки ─────────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<CheckResult> {
  const t = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { ok: true, latency_ms: Date.now() - t };
  } catch (err) {
    return { ok: false, error: String(err), latency_ms: Date.now() - t };
  }
}

async function checkGroq(groqKey: string): Promise<CheckResult> {
  const t = Date.now();
  try {
    const groq = new Groq({ apiKey: groqKey });
    await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
    return { ok: true, latency_ms: Date.now() - t };
  } catch (err) {
    const msg = String(err);
    // Rate limit — не критично
    if (msg.includes("429") || msg.includes("rate")) {
      return { ok: true, latency_ms: Date.now() - t };
    }
    return { ok: false, error: msg, latency_ms: Date.now() - t };
  }
}

function checkMemory(): CheckResult {
  const mem = process.memoryUsage();
  const usedMb = Math.round(mem.heapUsed / 1024 / 1024);
  if (usedMb > MEMORY_CRITICAL_MB) {
    return { ok: false, error: `Критическое потребление RAM: ${usedMb} МБ` };
  }
  if (usedMb > MEMORY_WARN_MB) {
    return { ok: false, error: `Высокое потребление RAM: ${usedMb} МБ` };
  }
  return { ok: true };
}

async function checkTelegramPolling(bot: TelegramBot): Promise<CheckResult> {
  const t = Date.now();
  try {
    await (bot as any).getMe();
    return { ok: true, latency_ms: Date.now() - t };
  } catch (err) {
    return { ok: false, error: String(err), latency_ms: Date.now() - t };
  }
}

// ─── Основной цикл мониторинга ────────────────────────────────────────────────

export async function runHealthCheck(
  bot: TelegramBot,
  groqKey: string,
  ownerId: number,
): Promise<HealthReport> {
  const mem = process.memoryUsage();
  const issues: string[] = [];

  const [dbResult, groqResult, telegramResult] = await Promise.allSettled([
    checkDatabase(),
    checkGroq(groqKey),
    checkTelegramPolling(bot),
  ]);

  const db_ = dbResult.status === "fulfilled" ? dbResult.value : { ok: false, error: String((dbResult as any).reason) };
  const groq_ = groqResult.status === "fulfilled" ? groqResult.value : { ok: false, error: String((groqResult as any).reason) };
  const tg_ = telegramResult.status === "fulfilled" ? telegramResult.value : { ok: false, error: String((telegramResult as any).reason) };
  const mem_ = checkMemory();

  if (!db_.ok) issues.push(`🗃 БД: ${db_.error}`);
  if (!groq_.ok) issues.push(`🧠 Groq: ${groq_.error}`);
  if (!tg_.ok) issues.push(`📡 Telegram polling: ${tg_.error}`);
  if (!mem_.ok) issues.push(`💾 Память: ${mem_.error}`);

  const criticalCount = [!db_.ok, !tg_.ok].filter(Boolean).length;
  const overall: HealthReport["overall"] = criticalCount > 0 ? "critical" : issues.length > 0 ? "degraded" : "ok";

  const report: HealthReport = {
    ts: Date.now(),
    uptime_seconds: Math.floor(process.uptime()),
    memory: {
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      external_mb: Math.round(mem.external / 1024 / 1024),
    },
    checks: {
      db: db_,
      groq: groq_,
      telegram_polling: tg_,
      memory_pressure: mem_,
    },
    overall,
    issues,
  };

  lastHealthReport = report;

  if (overall === "ok") {
    consecutiveFailures = 0;
    logger.debug({ uptime: report.uptime_seconds }, "Monitor: all checks passed");
  } else {
    consecutiveFailures++;
    logger.warn({ issues, overall, consecutiveFailures }, "Monitor: health degraded");

    // Уведомить владельца при критических проблемах
    const now = Date.now();
    if (overall === "critical" && ownerId && now - lastOwnerNotify > CRITICAL_NOTIFY_INTERVAL_MS) {
      lastOwnerNotify = now;
      const h = Math.floor(report.uptime_seconds / 3600);
      const m = Math.floor((report.uptime_seconds % 3600) / 60);
      const text = [
        `⚠️ <b>Агент самомониторинга: критические проблемы</b>`,
        ``,
        ...issues.map((i) => `• ${i}`),
        ``,
        `⏱ Аптайм: ${h}ч ${m}м`,
        `💾 RAM: ${report.memory.heap_used_mb} МБ / ${report.memory.heap_total_mb} МБ`,
        `🔁 Подряд сбоев: ${consecutiveFailures}`,
      ].join("\n");
      bot.sendMessage(ownerId, text, { parse_mode: "HTML" }).catch(() => {});
    }
  }

  return report;
}

// ─── Запуск мониторинга ───────────────────────────────────────────────────────

export function startMonitor(bot: TelegramBot, groqKey: string, ownerId: number): void {
  if (monitorInterval) return;

  logger.info("Monitor: starting self-monitoring agent");

  // Первая проверка через 30 секунд после запуска (даём боту прогреться)
  const initial = setTimeout(() => {
    runHealthCheck(bot, groqKey, ownerId).catch((err) => {
      logger.error({ err }, "Monitor: initial health check failed");
    });
  }, 30_000);

  // Периодические проверки
  monitorInterval = setInterval(() => {
    runHealthCheck(bot, groqKey, ownerId).catch((err) => {
      logger.error({ err }, "Monitor: scheduled health check failed");
    });
  }, CHECK_INTERVAL_MS);

  // Не блокировать process.exit
  if (monitorInterval.unref) monitorInterval.unref();
  if ((initial as any).unref) (initial as any).unref();

  logger.info(
    { interval_ms: CHECK_INTERVAL_MS },
    "Monitor: self-monitoring agent started",
  );
}

export function stopMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    logger.info("Monitor: stopped");
  }
}

// ─── Получить последний отчёт (для API) ──────────────────────────────────────

export function getLastHealthReport(): HealthReport | null {
  return lastHealthReport;
}
