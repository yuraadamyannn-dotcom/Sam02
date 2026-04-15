import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const CODE_GUARDIAN_DB_PATH = "/mnt/data/code_guardian.db";

type FixType = "wrap_handler" | "dedup_lock" | "middleware_patch" | "bot_filter" | "async_optimization" | "rollback" | "static_analysis" | "rate_limit" | "resource_guard";

type ErrorPattern = "duplicate_reply" | "handler_exception" | "bot_loop" | "memory_leak" | "integration_error" | "blocking_async" | "rate_limit" | "static_issue";

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

function resolveDataPath(requestedPath: string): string {
  const dir = requestedPath.substring(0, requestedPath.lastIndexOf("/"));
  try {
    mkdirSync(dir, { recursive: true });
    return requestedPath;
  } catch {
    const fallback = `${process.cwd()}/.data/${requestedPath.split("/").pop()}`;
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function getMessageIds(args: unknown[]): { chatId?: number; messageId?: number; updateId?: number; userId?: number } {
  const msg = args.find((arg): arg is TelegramBot.Message => Boolean(arg && typeof arg === "object" && "chat" in arg && "message_id" in arg));
  if (!msg) return {};
  return { chatId: msg.chat.id, messageId: msg.message_id, updateId: (msg as unknown as { update_id?: number }).update_id, userId: msg.from?.id };
}

export class AutoFixer {
  private readonly patchDir = resolveDataPath("/mnt/data/code_patches");

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

  recordStaticFinding(target: string, meta: Record<string, unknown>): void {
    this.recordFix("static_analysis", target, meta);
  }

  recordPatch(description: string, targetFile: string, beforeContent: string, afterContent: string, critical = false): number | null {
    if (critical) {
      this.recordFix("static_analysis", targetFile, { description, skipped: true, reason: "critical file requires admin confirmation" });
      return null;
    }
    const recent = this.db.prepare("SELECT COUNT(*) AS count FROM fixes WHERE created_at >= datetime('now', '-1 hour') AND patch_id IS NOT NULL").get() as { count: number };
    if (recent.count >= 3) {
      this.recordFix("static_analysis", targetFile, { description, skipped: true, reason: "patch rate limit reached" });
      return null;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = targetFile.replace(/[^\w.-]+/g, "_").slice(-120);
    const patchId = `${stamp}_${safe}`;
    const beforePath = join(this.patchDir, `${patchId}.before`);
    const afterPath = join(this.patchDir, `${patchId}.after`);
    writeFileSync(beforePath, beforeContent);
    writeFileSync(afterPath, afterContent);
    this.db.prepare("INSERT INTO fixes (type, target, meta_json, created_at, rolled_back, patch_id, description, before_path, after_path, result) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)")
      .run("resource_guard", targetFile, JSON.stringify({ description }), nowIso(), patchId, description, beforePath, afterPath, "saved");
    return Number((this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  }

  rollback_last_fix(patchId?: string): boolean {
    const row = patchId
      ? this.db.prepare("SELECT id, type, target, before_path FROM fixes WHERE rolled_back = 0 AND (patch_id = ? OR id = ?) ORDER BY id DESC LIMIT 1").get(patchId, Number(patchId) || -1) as { id: number; type: string; target: string; before_path?: string } | undefined
      : this.db.prepare("SELECT id, type, target, before_path FROM fixes WHERE rolled_back = 0 ORDER BY id DESC LIMIT 1").get() as { id: number; type: string; target: string; before_path?: string } | undefined;
    if (!row) return false;
    if (row.before_path && existsSync(row.before_path) && existsSync(row.target)) {
      const backup = join(this.patchDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${row.id}.rollback-current`);
      copyFileSync(row.target, backup);
      copyFileSync(row.before_path, row.target);
    }
    this.db.prepare("UPDATE fixes SET rolled_back = 1, rolled_back_at = ?, result = ? WHERE id = ?").run(nowIso(), "rolled_back", row.id);
    this.recordFix("rollback", row.target, { rolled_back_fix_id: row.id, rolled_back_type: row.type });
    return true;
  }

  private recordFix(type: FixType, target: string, meta: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO fixes (type, target, meta_json, created_at, rolled_back) VALUES (?, ?, ?, ?, 0)")
      .run(type, target, JSON.stringify(meta), nowIso());
  }
}

type AnalysisSeverity = "info" | "warning" | "critical";

interface AnalysisFinding {
  code: string;
  severity: AnalysisSeverity;
  file: string;
  line?: number;
  message: string;
}

export class CodeAnalyzer {
  private readonly sourceRoot = join(process.cwd(), "src");
  private lastFindings: AnalysisFinding[] = [];

  constructor(private readonly db: DatabaseSync, private readonly fixer: AutoFixer) {}

  analyze(): AnalysisFinding[] {
    const files = this.collectFiles(this.sourceRoot);
    const findings: AnalysisFinding[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      findings.push(...this.detectCredentials(file, text));
      findings.push(...this.detectBlockingIo(file, text));
      findings.push(...this.detectUnboundedFetch(file, text));
      findings.push(...this.detectMissingAwait(file, text));
    }
    findings.push(...this.detectDuplicateHandlers(files));
    this.lastFindings = findings;
    for (const finding of findings.slice(0, 50)) {
      this.db.prepare("INSERT INTO error_events (pattern, handler, chat_id, message_id, user_id, error, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("static_issue", "code_analyzer", null, null, null, `${finding.severity}:${finding.code}:${finding.file}:${finding.line ?? 0}:${finding.message}`, null, nowIso());
      this.fixer.recordStaticFinding(finding.file, finding);
    }
    logger.info({ findings: findings.length }, "CodeAnalyzer finished");
    return findings;
  }

  getLastFindings(limit = 20): AnalysisFinding[] {
    return this.lastFindings.slice(0, limit);
  }

  private collectFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          if (!["node_modules", "dist", ".data"].includes(item.name)) walk(full);
        } else if (item.name.endsWith(".ts") || item.name.endsWith(".tsx") || item.name.endsWith(".js")) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  private rel(file: string): string {
    return relative(process.cwd(), file);
  }

  private detectDuplicateHandlers(files: string[]): AnalysisFinding[] {
    const seen = new Map<string, { file: string; line: number }>();
    const findings: AnalysisFinding[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        const match = line.match(/bot\.onText\((\/\^.*?\/[gimsuy]*)/);
        if (!match) return;
        const key = match[1]!;
        const prev = seen.get(key);
        if (prev) {
          findings.push({ code: "duplicate_handler", severity: "warning", file: this.rel(file), line: idx + 1, message: `handler duplicates ${prev.file}:${prev.line}` });
        } else {
          seen.set(key, { file: this.rel(file), line: idx + 1 });
        }
      });
    }
    return findings;
  }

  private detectCredentials(file: string, text: string): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    const patterns = [/sk-[A-Za-z0-9_-]{20,}/, /xox[baprs]-[A-Za-z0-9-]{20,}/, /AIza[0-9A-Za-z_-]{20,}/, /(?:token|api[_-]?key|secret)\s*[:=]\s*["'][^"']{16,}["']/i];
    text.split("\n").forEach((line, idx) => {
      if (line.includes("process.env")) return;
      if (patterns.some(re => re.test(line))) findings.push({ code: "hardcoded_credential", severity: "critical", file: this.rel(file), line: idx + 1, message: "possible hardcoded credential" });
    });
    return findings;
  }

  private detectBlockingIo(file: string, text: string): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    text.split("\n").forEach((line, idx) => {
      if (/\b(execSync|spawnSync|readFileSync|writeFileSync|readdirSync|statSync)\b/.test(line) && this.insideAsync(text, idx)) {
        findings.push({ code: "blocking_io_async", severity: "warning", file: this.rel(file), line: idx + 1, message: "blocking IO inside async flow" });
      }
    });
    return findings;
  }

  private detectUnboundedFetch(file: string, text: string): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    text.split("\n").forEach((line, idx) => {
      if (line.includes("fetch(") && !line.includes("AbortSignal.timeout") && !line.includes("signal:")) {
        findings.push({ code: "fetch_without_timeout", severity: "warning", file: this.rel(file), line: idx + 1, message: "fetch without explicit timeout may leak connections" });
      }
    });
    return findings;
  }

  private detectMissingAwait(file: string, text: string): AnalysisFinding[] {
    const findings: AnalysisFinding[] = [];
    text.split("\n").forEach((line, idx) => {
      if (/\b(bot\.(send|delete|answer|get)|pool\.query|db\.)/.test(line) && !/\b(await|void|return|Promise\.all|\.then\()/.test(line)) {
        findings.push({ code: "possibly_missing_await", severity: "info", file: this.rel(file), line: idx + 1, message: "async-looking call without await/void/return" });
      }
    });
    return findings;
  }

  private insideAsync(text: string, lineIndex: number): boolean {
    const before = text.split("\n").slice(Math.max(0, lineIndex - 25), lineIndex + 1).join("\n");
    return /async\s*(function|\(|[A-Za-z0-9_]+\s*=>)/.test(before);
  }
}

export class RateLimiter {
  private readonly events = new Map<string, number[]>();
  private readonly strikes = new Map<string, { count: number; mutedUntil: number }>();

  constructor(private readonly db: DatabaseSync) {}

  allow(meta: { userId?: number; chatId: number; isCommand: boolean; isAdmin: boolean; heapMb?: number }): { allowed: boolean; reason?: string; warn?: boolean } {
    if (meta.isAdmin) return { allowed: true };
    const now = Date.now();
    const userKey = `user:${meta.userId ?? 0}`;
    const chatKey = `chat:${meta.chatId}`;
    const globalKey = "global";
    const userStrike = this.strikes.get(userKey);
    if (userStrike && userStrike.mutedUntil > now) return { allowed: false, reason: "temporary_ignore" };
    const dynamic = meta.heapMb && meta.heapMb > 500 ? 0.6 : 1;
    const checks = [
      this.check(userKey, 60_000, Math.floor(20 * dynamic), now),
      this.check(chatKey, 60_000, Math.floor(50 * dynamic), now),
      this.check(globalKey, 60_000, Math.floor(1000 * dynamic), now),
      meta.isCommand ? this.check(`${userKey}:commands`, 10_000, 5, now) : { ok: true },
    ];
    const failed = checks.find(x => !x.ok);
    if (!failed) return { allowed: true };
    const count = (userStrike?.count ?? 0) + 1;
    const mutedUntil = count >= 3 ? now + 60 * 60_000 : 0;
    this.strikes.set(userKey, { count, mutedUntil });
    this.db.prepare("INSERT INTO guardian_metrics (key, value, created_at) VALUES (?, ?, ?)").run("rate_limit_block", 1, nowIso());
    return { allowed: false, reason: failed.reason, warn: count <= 2 };
  }

  getStats(): Record<string, unknown> {
    return { buckets: this.events.size, offenders: [...this.strikes.entries()].filter(([, v]) => v.mutedUntil > Date.now()).length };
  }

  private check(key: string, windowMs: number, max: number, now: number): { ok: boolean; reason?: string } {
    const list = (this.events.get(key) ?? []).filter(ts => now - ts <= windowMs);
    list.push(now);
    this.events.set(key, list);
    return list.length <= max ? { ok: true } : { ok: false, reason: key };
  }
}

export class CodeGuardian {
  readonly fixer: AutoFixer;
  private db: DatabaseSync;
  private recentReplies = new Map<string, number>();
  private errorCounts = new Map<string, number>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private analysisTimer: ReturnType<typeof setInterval> | null = null;
  private lastAdminAlert = 0;
  private baselineHeap = process.memoryUsage().heapUsed;
  readonly analyzer: CodeAnalyzer;
  readonly rateLimiter: RateLimiter;

  constructor(private readonly options: GuardianOptions = {}) {
    const dbPath = resolveSqlitePath(options.dbPath ?? CODE_GUARDIAN_DB_PATH);
    this.db = new DatabaseSync(dbPath);
    this.init();
    this.fixer = new AutoFixer(this.db);
    this.analyzer = new CodeAnalyzer(this.db, this.fixer);
    this.rateLimiter = new RateLimiter(this.db);
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
    this.ensureColumn("fixes", "patch_id", "TEXT");
    this.ensureColumn("fixes", "description", "TEXT");
    this.ensureColumn("fixes", "before_path", "TEXT");
    this.ensureColumn("fixes", "after_path", "TEXT");
    this.ensureColumn("fixes", "result", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  async allowMessage(msg: TelegramBot.Message, bot?: TelegramBot, isAdmin = false): Promise<boolean> {
    const result = this.rateLimiter.allow({
      userId: msg.from?.id,
      chatId: msg.chat.id,
      isCommand: Boolean(msg.text?.startsWith("/")),
      isAdmin,
      heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    });
    if (result.allowed) return true;
    this.recordPattern("rate_limit", result.reason ?? "rate_limiter", { chatId: msg.chat.id, messageId: msg.message_id, userId: msg.from?.id }, new Error("rate limit exceeded"));
    this.fixer.recordStaticFinding("rate_limiter", { result });
    if (result.warn && bot) {
      await bot.sendMessage(msg.chat.id, "не так быстро, я записываю...", { reply_to_message_id: msg.message_id }).catch(() => {});
    } else if (result.reason === "global" && bot) {
      await this.alertOwner(bot, "⚠️ <b>CodeGuardian</b>: глобальный лимит сообщений превышен, включено тихое ограничение нагрузки.");
    }
    return false;
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
    if (!this.analysisTimer) {
      setTimeout(() => void this.runAnalysis(bot).catch(err => logger.warn({ err }, "Startup CodeAnalyzer failed")), 5000).unref?.();
      this.analysisTimer = setInterval(() => void this.runAnalysis(bot).catch(err => logger.warn({ err }, "Periodic CodeAnalyzer failed")), 30 * 60_000);
      this.analysisTimer.unref?.();
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
    return { dbPath: this.options.dbPath ?? CODE_GUARDIAN_DB_PATH, processedUpdates: processed.count, recentErrors: errors, activeFixes: fixes, heapMb: heap, baselineHeapMb: Math.round(this.baselineHeap / 1024 / 1024), rateLimiter: this.rateLimiter.getStats(), analyzerFindings: this.analyzer.getLastFindings(10) };
  }

  runAnalysisNow(): AnalysisFinding[] {
    return this.analyzer.analyze();
  }

  rollbackLastFix(patchId?: string): boolean {
    return this.fixer.rollback_last_fix(patchId);
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

  private async runAnalysis(bot?: TelegramBot): Promise<void> {
    const findings = this.analyzer.analyze();
    const critical = findings.filter(f => f.severity === "critical");
    if (critical.length) {
      await this.alertOwner(bot, `⚠️ <b>CodeAnalyzer</b>: найдено критических проблем: <code>${critical.length}</code>\n<pre>${escapeHtml(critical.slice(0, 5).map(f => `${f.file}:${f.line ?? 0} ${f.message}`).join("\n"))}</pre>`);
    }
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
