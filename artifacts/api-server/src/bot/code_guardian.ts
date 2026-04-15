import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const CODE_GUARDIAN_DB_PATH = "/mnt/data/code_guardian.db";

type FixType = "wrap_handler" | "dedup_lock" | "middleware_patch" | "bot_filter" | "async_optimization" | "rollback";

type ErrorPattern = "duplicate_reply" | "handler_exception" | "bot_loop" | "memory_leak" | "integration_error" | "blocking_async";

interface GuardianOptions {
  dbPath?: string;
  ownerId?: number;
  memoryWarnMb?: number;
  memoryCriticalMb?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveSqlitePath(requestedPath: string): string {
  const dir = requestedPath.substring(0, requestedPath.lastIndexOf("/"));
  try {
    mkdirSync(dir, { recursive: true });
    return requestedPath;
  } catch (err) {
    const fallback = `${process.cwd()}/.data/${requestedPath.split("/").pop()}`;
    mkdirSync(`${process.cwd()}/.data`, { recursive: true });
    logger.warn({ err, requestedPath, fallback }, "CodeGuardian SQLite path unavailable, using workspace fallback");
    return fallback;
  }
}

function getMessageIds(args: unknown[]): { chatId?: number; messageId?: number; updateId?: number; userId?: number } {
  const msg = args.find((arg): arg is TelegramBot.Message => Boolean(arg && typeof arg === "object" && "chat" in arg && "message_id" in arg));
  if (!msg) return {};
  return { chatId: msg.chat.id, messageId: msg.message_id, updateId: (msg as unknown as { update_id?: number }).update_id, userId: msg.from?.id };
}

export class AutoFixer {
  constructor(private readonly db: DatabaseSync) {}

  wrap_handler(handlerName: string): void {
    this.recordFix("wrap_handler", handlerName, { active: true });
  }

  add_dedup_lock(keyPattern: string): void {
    this.recordFix("dedup_lock", keyPattern, { ttl_seconds: 3600 });
  }

  patch_middleware(order: string): void {
    this.recordFix("middleware_patch", order, { runtime_guard: true });
  }

  add_bot_filter(): void {
    this.recordFix("bot_filter", "message.from_user.is_bot", { active: true });
  }

  optimize_async(blockingFunction: string): void {
    this.recordFix("async_optimization", blockingFunction, { strategy: "asyncio.to_thread equivalent: Promise/off-thread guard required" });
  }

  rollback_last_fix(): void {
    const row = this.db.prepare("SELECT id, type, target FROM fixes WHERE rolled_back = 0 ORDER BY id DESC LIMIT 1").get() as { id: number; type: string; target: string } | undefined;
    if (!row) return;
    this.db.prepare("UPDATE fixes SET rolled_back = 1, rolled_back_at = ? WHERE id = ?").run(nowIso(), row.id);
    this.recordFix("rollback", row.target, { rolled_back_fix_id: row.id, rolled_back_type: row.type });
  }

  private recordFix(type: FixType, target: string, meta: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO fixes (type, target, meta_json, created_at, rolled_back) VALUES (?, ?, ?, ?, 0)")
      .run(type, target, JSON.stringify(meta), nowIso());
  }
}

export class CodeGuardian {
  readonly fixer: AutoFixer;
  private db: DatabaseSync;
  private recentReplies = new Map<string, number>();
  private errorCounts = new Map<string, number>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lastAdminAlert = 0;
  private baselineHeap = process.memoryUsage().heapUsed;

  constructor(private readonly options: GuardianOptions = {}) {
    const dbPath = resolveSqlitePath(options.dbPath ?? CODE_GUARDIAN_DB_PATH);
    this.db = new DatabaseSync(dbPath);
    this.init();
    this.fixer = new AutoFixer(this.db);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_updates (key TEXT PRIMARY KEY, chat_id INTEGER, message_id INTEGER, user_id INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS error_events (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, handler TEXT, chat_id INTEGER, message_id INTEGER, user_id INTEGER, error TEXT NOT NULL, stack TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, target TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL, rolled_back INTEGER NOT NULL DEFAULT 0, rolled_back_at TEXT);
      CREATE TABLE IF NOT EXISTS guardian_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_processed_updates_created ON processed_updates(created_at);
      CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
    `);
  }

  async claimUpdate(key: string, meta: { chatId?: number; messageId?: number; userId?: number } = {}): Promise<boolean> {
    try {
      const result = this.db.prepare("INSERT OR IGNORE INTO processed_updates (key, chat_id, message_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(key, meta.chatId ?? null, meta.messageId ?? null, meta.userId ?? null, nowIso());
      if (result.changes === 0) {
        this.recordPattern("duplicate_reply", "dedupe", meta, new Error(`duplicate update ${key}`));
        this.fixer.add_dedup_lock(key);
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err, key }, "CodeGuardian dedupe failed open");
      return true;
    }
  }

  shouldIgnoreMessage(msg: TelegramBot.Message, botId = 0): boolean {
    if (!msg.from) return false;
    if (msg.from.is_bot || (botId > 0 && msg.from.id === botId)) {
      this.recordPattern("bot_loop", "bot_filter", { chatId: msg.chat.id, messageId: msg.message_id, userId: msg.from.id }, new Error("bot message ignored"));
      this.fixer.add_bot_filter();
      return true;
    }
    return false;
  }

  async runHandler(handlerName: string, msg: TelegramBot.Message | undefined, handler: () => Promise<void>, bot?: TelegramBot): Promise<void> {
    try {
      await handler();
    } catch (err) {
      const meta = msg ? { chatId: msg.chat.id, messageId: msg.message_id, userId: msg.from?.id } : {};
      this.recordPattern("handler_exception", handlerName, meta, err);
      this.fixer.wrap_handler(handlerName);
      logger.error({ err, handlerName, ...meta }, "CodeGuardian caught handler exception");
      if (bot && msg?.chat.id) {
        await bot.sendMessage(msg.chat.id, "произошла ошибка, но я работаю над этим", { reply_to_message_id: msg.message_id }).catch(() => {});
      }
      await this.alertOwner(bot, `🛠 <b>CodeGuardian поймал ошибку</b>\n\nХендлер: <code>${escapeHtml(handlerName)}</code>\nОшибка: <code>${escapeHtml(String(err)).slice(0, 900)}</code>`);
    }
  }

  wrapCallback<T extends (...args: any[]) => unknown>(handlerName: string, callback: T, bot?: TelegramBot): T {
    return ((...args: Parameters<T>) => {
      const ids = getMessageIds(args);
      const msg = args.find((arg): arg is TelegramBot.Message => Boolean(arg && typeof arg === "object" && "chat" in arg && "message_id" in arg));
      return Promise.resolve()
        .then(() => callback(...args))
        .catch(async err => {
          this.recordPattern("handler_exception", handlerName, ids, err);
          this.fixer.wrap_handler(handlerName);
          logger.error({ err, handlerName, ...ids }, "CodeGuardian wrapped callback failed");
          if (bot && msg?.chat.id) await bot.sendMessage(msg.chat.id, "произошла ошибка, но я работаю над этим", { reply_to_message_id: msg.message_id }).catch(() => {});
        });
    }) as T;
  }

  recordBotReply(chatId: number, userId: number | undefined, messageId: number | undefined): void {
    if (!messageId) return;
    const key = `${chatId}:${userId ?? 0}:${messageId}`;
    const now = Date.now();
    const prev = this.recentReplies.get(key);
    if (prev && now - prev < 5000) {
      this.recordPattern("duplicate_reply", "send_guard", { chatId, messageId, userId }, new Error("two bot replies within 5 seconds"));
      this.fixer.add_dedup_lock(key);
    }
    this.recentReplies.set(key, now);
    if (this.recentReplies.size > 2000) {
      const cutoff = now - 60_000;
      for (const [k, ts] of this.recentReplies) if (ts < cutoff) this.recentReplies.delete(k);
    }
  }

  recordIntegrationError(name: string, err: unknown): void {
    const key = `integration:${name}`;
    const count = (this.errorCounts.get(key) ?? 0) + 1;
    this.errorCounts.set(key, count);
    this.recordPattern("integration_error", name, {}, err);
    if (count >= 3) this.fixer.optimize_async(name);
  }

  start(bot?: TelegramBot): void {
    if (!this.monitorTimer) {
      this.monitorTimer = setInterval(() => void this.monitor(bot).catch(err => logger.warn({ err }, "CodeGuardian monitor failed")), 60_000);
      this.monitorTimer.unref?.();
    }
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanup(), 10 * 60_000);
      this.cleanupTimer.unref?.();
    }
    process.on("uncaughtException", err => this.recordPattern("handler_exception", "process_uncaught", {}, err));
    process.on("unhandledRejection", reason => this.recordPattern("handler_exception", "process_rejection", {}, reason));
    logger.info("CodeGuardian self-healing monitor started");
  }

  getStats(): Record<string, unknown> {
    const processed = this.db.prepare("SELECT COUNT(*) AS count FROM processed_updates").get() as { count: number };
    const errors = this.db.prepare("SELECT pattern, COUNT(*) AS count FROM error_events WHERE created_at >= datetime('now', '-1 hour') GROUP BY pattern").all() as Array<Record<string, unknown>>;
    const fixes = this.db.prepare("SELECT type, COUNT(*) AS count FROM fixes WHERE rolled_back = 0 GROUP BY type").all() as Array<Record<string, unknown>>;
    const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    return { dbPath: this.options.dbPath ?? CODE_GUARDIAN_DB_PATH, processedUpdates: processed.count, recentErrors: errors, activeFixes: fixes, heapMb: heap, baselineHeapMb: Math.round(this.baselineHeap / 1024 / 1024) };
  }

  private async monitor(bot?: TelegramBot): Promise<void> {
    const mem = process.memoryUsage();
    const heapMb = mem.heapUsed / 1024 / 1024;
    this.db.prepare("INSERT INTO guardian_metrics (key, value, created_at) VALUES (?, ?, ?)").run("heap_mb", heapMb, nowIso());
    const warn = this.options.memoryWarnMb ?? 400;
    const critical = this.options.memoryCriticalMb ?? 700;
    if (heapMb > warn) {
      this.recordPattern("memory_leak", "memory_monitor", {}, new Error(`heap ${Math.round(heapMb)}MB`));
      if (global.gc) global.gc();
      if (heapMb > critical) await this.alertOwner(bot, `💾 <b>CodeGuardian: критическая RAM</b>\nHeap: <code>${Math.round(heapMb)} MB</code>\nРекомендация: graceful restart после сохранения очередей.`);
    }
    const recentSlow = this.db.prepare("SELECT COUNT(*) AS count FROM guardian_metrics WHERE key = 'event_loop_lag_ms' AND value > 2000 AND created_at >= datetime('now', '-10 minutes')").get() as { count: number };
    if (recentSlow.count > 0) this.recordPattern("blocking_async", "event_loop", {}, new Error("event loop lag > 2s"));
  }

  private cleanup(): void {
    this.db.prepare("DELETE FROM processed_updates WHERE created_at < datetime('now', '-1 hour')").run();
    this.db.prepare("DELETE FROM guardian_metrics WHERE created_at < datetime('now', '-24 hours')").run();
    this.db.prepare("DELETE FROM error_events WHERE created_at < datetime('now', '-7 days')").run();
  }

  private recordPattern(pattern: ErrorPattern, handler: string, meta: { chatId?: number; messageId?: number; userId?: number }, err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack ?? null : null;
    this.db.prepare("INSERT INTO error_events (pattern, handler, chat_id, message_id, user_id, error, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(pattern, handler, meta.chatId ?? null, meta.messageId ?? null, meta.userId ?? null, error, stack, nowIso());
  }

  private async alertOwner(bot: TelegramBot | undefined, text: string): Promise<void> {
    const ownerId = this.options.ownerId;
    if (!bot || !ownerId) return;
    const now = Date.now();
    if (now - this.lastAdminAlert < 5 * 60_000) return;
    this.lastAdminAlert = now;
    await bot.sendMessage(ownerId, text, { parse_mode: "HTML" }).catch(() => {});
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

export const codeGuardian = new CodeGuardian({ ownerId: Number(process.env["ADMIN_TELEGRAM_ID"] ?? 0) || undefined });
