import { DatabaseSync } from "node:sqlite";
import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

function nowIso(): string {
  return new Date().toISOString();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════════════
// AUTO SCALER — Tiered degradation based on storage thresholds
// ═══════════════════════════════════════════════════════════════

export type ScaleAction =
  | "ok"
  | "warn"           // approaching limit: log + economy mode
  | "aggressive"     // past 85%: accelerate migration, disable proactive
  | "emergency"      // past 90-95%: read-only + admin alert
  | "critical";      // past 95%+: writes blocked + urgent alert

export interface AutoScalerState {
  qdrantMb: number;
  qdrantQuotaMb: number;
  qdrantAction: ScaleAction;
  zillizMb: number;
  zillizQuotaMb: number;
  zillizAction: ScaleAction;
  sqliteMb: number;
  sqliteAction: ScaleAction;
  latencyMs: number;
  latencyAction: "ok" | "warn" | "degraded";
  economyMode: boolean;
  sqliteOnly: boolean;
  zillizBlocked: boolean;
  updatedAt: string;
}

export interface AutoScalerCallbacks {
  setEconomyMode(on: boolean): void;
  setSqliteOnly(on: boolean): void;
  setZillizBlocked(on: boolean): void;
  alertAdmin(msg: string): void;
  log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
}

export class AutoScaler {
  private lastState: AutoScalerState | null = null;
  private lastAdminAlert = 0;

  evaluate(
    opts: {
      qdrantMb: number;
      qdrantQuotaMb: number;
      zillizMb: number;
      zillizQuotaMb: number;
      sqliteMb: number;
      qdrantLatencyMs: number;
      zillizLatencyMs: number;
    },
    callbacks: AutoScalerCallbacks,
  ): AutoScalerState {
    const latencyMs = Math.max(opts.qdrantLatencyMs, opts.zillizLatencyMs);

    const qdrantAction = this.classifyQdrant(opts.qdrantMb, opts.qdrantQuotaMb, callbacks);
    const zillizAction = this.classifyZilliz(opts.zillizMb, opts.zillizQuotaMb, callbacks);
    const sqliteAction = this.classifySqlite(opts.sqliteMb, callbacks);
    const latencyAction = this.classifyLatency(latencyMs, callbacks);

    const economyMode =
      qdrantAction === "warn" ||
      qdrantAction === "aggressive" ||
      zillizAction === "warn" ||
      zillizAction === "aggressive" ||
      sqliteAction === "warn" ||
      latencyAction === "degraded";

    const sqliteOnly =
      qdrantAction === "emergency" ||
      qdrantAction === "critical" ||
      sqliteAction === "emergency" ||
      sqliteAction === "critical";

    const zillizBlocked =
      zillizAction === "emergency" ||
      zillizAction === "critical";

    callbacks.setEconomyMode(economyMode);
    callbacks.setSqliteOnly(sqliteOnly);
    callbacks.setZillizBlocked(zillizBlocked);

    const state: AutoScalerState = {
      qdrantMb: opts.qdrantMb,
      qdrantQuotaMb: opts.qdrantQuotaMb,
      qdrantAction,
      zillizMb: opts.zillizMb,
      zillizQuotaMb: opts.zillizQuotaMb,
      zillizAction,
      sqliteMb: opts.sqliteMb,
      sqliteAction,
      latencyMs,
      latencyAction,
      economyMode,
      sqliteOnly,
      zillizBlocked,
      updatedAt: nowIso(),
    };

    this.lastState = state;
    return state;
  }

  getLastState(): AutoScalerState | null {
    return this.lastState;
  }

  private classifyQdrant(usedMb: number, quotaMb: number, cb: AutoScalerCallbacks): ScaleAction {
    if (quotaMb <= 0) return "ok";
    const pct = usedMb / quotaMb;

    if (pct >= 0.95) {
      // QDRANT ≥ 95%: read-only, urgent alert, only SQLite fallback
      cb.log("error", "Qdrant CRITICAL: ≥ 95% capacity — writes blocked, switching to SQLite", { usedMb, quotaMb, pct: (pct * 100).toFixed(1) });
      this.throttledAlert(cb, [
        `🚨 <b>AutoScaler: Qdrant КРИТИЧЕСКИЙ уровень</b>`,
        `Использовано: <code>${Math.round(usedMb)} МБ / ${quotaMb} МБ (${(pct * 100).toFixed(0)}%)</code>`,
        `Статус: Запись заблокирована, только SQLite fallback.`,
        `Действие: Срочно освободите место или увеличьте квоту Qdrant.`,
        `Команда: /rollback чтобы откатить последние фиксы, /memory_stats для деталей.`,
      ].join("\n"));
      return "critical";
    }

    if (pct >= 0.85) {
      // QDRANT ≥ 85%: экстренная миграция, отключение proactive-фич, алерт
      cb.log("error", "Qdrant EMERGENCY: ≥ 85% — accelerated migration, proactive features off", { usedMb, pct: (pct * 100).toFixed(1) });
      this.throttledAlert(cb, [
        `⚠️ <b>AutoScaler: Qdrant аварийный режим</b>`,
        `Использовано: <code>${Math.round(usedMb)} МБ / ${quotaMb} МБ (${(pct * 100).toFixed(0)}%)</code>`,
        `Статус: Экстренная миграция данных старше 24ч → Zilliz. Proactive-фичи отключены.`,
        `Требуется внимание: <code>/memory_stats</code>`,
      ].join("\n"));
      return "emergency";
    }

    if (pct >= 0.70) {
      // QDRANT ≥ 70%: ускоренная миграция, агрессивная очистка неактивных
      cb.log("warn", "Qdrant WARN: ≥ 70% — accelerating cold migration", { usedMb, pct: (pct * 100).toFixed(1) });
      return "aggressive";
    }

    if (pct >= 0.50) {
      cb.log("info", "Qdrant usage ≥ 50%, monitoring", { usedMb, pct: (pct * 100).toFixed(1) });
      return "warn";
    }

    return "ok";
  }

  private classifyZilliz(usedMb: number, quotaMb: number, cb: AutoScalerCallbacks): ScaleAction {
    if (quotaMb <= 0) return "ok";
    const pct = usedMb / quotaMb;

    if (pct >= 0.95) {
      // ZILLIZ ≥ 95% (≈ 4.75 GB из 5 GB): полная блокировка записи, экстренный алерт
      cb.log("error", "Zilliz CRITICAL: ≥ 95% — all writes blocked", { usedMb, quotaMb, pct: (pct * 100).toFixed(1) });
      this.throttledAlert(cb, [
        `🚨 <b>AutoScaler: Zilliz КРИТИЧЕСКИЙ</b>`,
        `Использовано: <code>${Math.round(usedMb)} МБ / ${quotaMb} МБ (${(pct * 100).toFixed(0)}%)</code>`,
        `Статус: Запись полностью заблокирована. Всё через SQLite.`,
        `Рекомендации:`,
        ` • Удалить старые диалоги (старше 90 дней)`,
        ` • Перейти на платный план Zilliz`,
        ` • Экспортировать архивные данные`,
        `Команда: /memory_stats для деталей.`,
      ].join("\n"));
      return "critical";
    }

    if (pct >= 0.90) {
      // ZILLIZ ≥ 90% (≈ 4.5 GB из 5 GB):
      // — Агрессивное сжатие: удаление raw-текстов, оставление только векторов
      // — Экстренное уведомление админу с рекомендацией перехода на платный план
      // — Все новые диалоги только в SQLite, в Zilliz только профили
      // — Архивация: объединение мелких batch-ов в один compressed вектор на пользователя
      cb.log("error", "Zilliz EMERGENCY: ≥ 90% — dialog writes to SQLite only, profiles only in Zilliz", { usedMb, quotaMb, pct: (pct * 100).toFixed(1) });
      this.throttledAlert(cb, [
        `🚨 <b>AutoScaler: Zilliz аварийный режим (${(pct * 100).toFixed(0)}%)</b>`,
        `Использовано: <code>${Math.round(usedMb)} МБ / ${quotaMb} МБ</code>`,
        `Статус: Новые диалоги — только SQLite. В Zilliz только профили пользователей.`,
        `Применено: агрессивное сжатие архивных данных.`,
        `⚠️ Рекомендуется перейти на платный план Zilliz или удалить данные старше 60 дней.`,
        `Команда: /memory_stats для деталей.`,
      ].join("\n"));
      return "emergency";
    }

    if (pct >= 0.70) {
      // ZILLIZ ≥ 70% (≈ 3.5 GB из 5 GB):
      // — Агрессивная архивация: удаление raw-текстов, оставление только векторов
      // — Сжатие: объединение мелких архивов в batch-ы
      // — Ускоренная очистка: диалоги без активности 30+ дней → удаление raw
      cb.log("warn", "Zilliz WARN: ≥ 70% — aggressive archival, compressing old data", { usedMb, pct: (pct * 100).toFixed(1) });
      this.throttledAlert(cb, [
        `⚠️ <b>AutoScaler: Zilliz заполнен на ${(pct * 100).toFixed(0)}%</b>`,
        `Использовано: <code>${Math.round(usedMb)} МБ / ${quotaMb} МБ</code>`,
        `Применено: агрессивная архивация данных. Режим экономии активирован.`,
      ].join("\n"));
      return "aggressive";
    }

    if (pct >= 0.50) {
      cb.log("info", "Zilliz usage ≥ 50%", { usedMb, pct: (pct * 100).toFixed(1) });
      return "warn";
    }

    return "ok";
  }

  private classifySqlite(sizeMb: number, cb: AutoScalerCallbacks): ScaleAction {
    if (sizeMb > 95) {
      cb.log("error", "SQLite CRITICAL: > 95 MB — external writes paused", { sizeMb });
      this.throttledAlert(cb, `🚨 <b>AutoScaler: SQLite аварийный режим</b>\nРазмер базы: <code>${Math.round(sizeMb)} МБ</code>\nВнешние записи приостановлены. Требуется очистка.`);
      return "critical";
    }
    if (sizeMb > 70) {
      cb.log("warn", "SQLite WARN: > 70 MB — economy mode", { sizeMb });
      return "warn";
    }
    return "ok";
  }

  private classifyLatency(latencyMs: number, cb: AutoScalerCallbacks): "ok" | "warn" | "degraded" {
    if (latencyMs > 1000) {
      cb.log("warn", "Vector search latency very high — economy mode", { latencyMs });
      return "degraded";
    }
    if (latencyMs > 200) {
      cb.log("warn", "Vector search latency elevated", { latencyMs });
      return "warn";
    }
    return "ok";
  }

  private throttledAlert(cb: AutoScalerCallbacks, msg: string): void {
    const now = Date.now();
    if (now - this.lastAdminAlert < 30 * 60_000) return;
    this.lastAdminAlert = now;
    cb.alertAdmin(msg);
  }
}

// ═══════════════════════════════════════════════════════════════
// FIX LEARNER — История + автоматическое применение известных фиксов
// ═══════════════════════════════════════════════════════════════

export interface KnownFix {
  id: number;
  errorPattern: string;
  errorSubstring: string;
  fixDescription: string;
  successCount: number;
  failureCount: number;
  lastAppliedAt: string | null;
  autoApply: boolean;
}

export interface FixApplication {
  fixId: number;
  applied: boolean;
  reason: string;
}

export class FixLearner {
  constructor(private readonly db: DatabaseSync) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS known_fixes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        error_pattern TEXT NOT NULL,
        error_substring TEXT NOT NULL,
        fix_description TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_applied_at TEXT,
        auto_apply INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fix_applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        known_fix_id INTEGER NOT NULL,
        error_event_id INTEGER,
        result TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fix_weekly_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL,
        errors_caught INTEGER NOT NULL DEFAULT 0,
        fixes_applied INTEGER NOT NULL DEFAULT 0,
        fixes_succeeded INTEGER NOT NULL DEFAULT 0,
        fixes_failed INTEGER NOT NULL DEFAULT 0,
        uptime_pct REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    this.seedBuiltinFixes();
  }

  private seedBuiltinFixes(): void {
    const builtins: Array<{ pattern: string; substr: string; desc: string }> = [
      { pattern: "duplicate_reply",   substr: "duplicate update",          desc: "Дублирующиеся ответы: добавить dedup lock по update_id" },
      { pattern: "bot_loop",          substr: "bot message ignored",        desc: "Бот отвечает сам себе: добавить фильтр is_bot в dispatcher" },
      { pattern: "memory_leak",       substr: "heap",                       desc: "Утечка памяти: вызов global.gc() + алерт если > 700 МБ" },
      { pattern: "handler_exception", substr: "ETELEGRAM",                  desc: "Telegram API ошибка: повторить через 5с с backoff" },
      { pattern: "rate_limit",        substr: "rate limit exceeded",        desc: "Превышение лимита: включить sliding window + мягкий ответ" },
      { pattern: "integration_error", substr: "circuit breaker is open",    desc: "Circuit breaker сработал: переключиться на SQLite fallback" },
      { pattern: "handler_exception", substr: "Cannot read properties",     desc: "Null-reference: добавить optional chaining проверку" },
      { pattern: "blocking_async",    substr: "event loop lag",             desc: "Блокировка event loop: перенести тяжёлую операцию в setImmediate" },
    ];

    for (const b of builtins) {
      const exists = this.db.prepare("SELECT id FROM known_fixes WHERE error_pattern = ? AND error_substring = ?").get(b.pattern, b.substr);
      if (!exists) {
        this.db.prepare(
          "INSERT INTO known_fixes (error_pattern, error_substring, fix_description, auto_apply, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
        ).run(b.pattern, b.substr, b.desc, nowIso(), nowIso());
      }
    }
  }

  findKnownFix(errorPattern: string, errorMessage: string): KnownFix | null {
    const rows = this.db.prepare(
      "SELECT * FROM known_fixes WHERE error_pattern = ? AND auto_apply = 1 ORDER BY success_count DESC"
    ).all(errorPattern) as Array<Record<string, unknown>>;

    for (const row of rows) {
      const substr = String(row["error_substring"] ?? "");
      if (!substr || errorMessage.toLowerCase().includes(substr.toLowerCase())) {
        return this.mapRow(row);
      }
    }
    return null;
  }

  recordApplication(fixId: number, errorEventId: number | null, result: "success" | "failure" | "skipped", notes?: string): void {
    this.db.prepare(
      "INSERT INTO fix_applications (known_fix_id, error_event_id, result, notes, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(fixId, errorEventId ?? null, result, notes ?? null, nowIso());

    if (result === "success") {
      this.db.prepare("UPDATE known_fixes SET success_count = success_count + 1, last_applied_at = ?, updated_at = ? WHERE id = ?")
        .run(nowIso(), nowIso(), fixId);
    } else if (result === "failure") {
      this.db.prepare("UPDATE known_fixes SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), fixId);
      const row = this.db.prepare("SELECT failure_count FROM known_fixes WHERE id = ?").get(fixId) as { failure_count: number } | undefined;
      if (row && row.failure_count >= 5) {
        this.db.prepare("UPDATE known_fixes SET auto_apply = 0, updated_at = ? WHERE id = ?").run(nowIso(), fixId);
        logger.warn({ fixId }, "FixLearner: auto_apply disabled after 5 consecutive failures");
      }
    }
  }

  recordNewPattern(errorPattern: string, errorMessage: string, fixDescription: string, autoApply = false): number {
    const exists = this.db.prepare("SELECT id FROM known_fixes WHERE error_pattern = ? AND error_substring = ?").get(errorPattern, errorMessage.slice(0, 80));
    if (exists) return Number((exists as { id: number }).id);

    const result = this.db.prepare(
      "INSERT INTO known_fixes (error_pattern, error_substring, fix_description, auto_apply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(errorPattern, errorMessage.slice(0, 80), fixDescription, autoApply ? 1 : 0, nowIso(), nowIso());

    return Number(result.lastInsertRowid);
  }

  getTopFixes(limit = 10): KnownFix[] {
    const rows = this.db.prepare(
      "SELECT * FROM known_fixes ORDER BY success_count DESC, created_at DESC LIMIT ?"
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRow(r));
  }

  getWeeklyStats(): { errorsThisWeek: number; fixesApplied: number; fixesSucceeded: number } {
    const errors = this.db.prepare(
      "SELECT COUNT(*) AS count FROM fix_applications WHERE created_at >= datetime('now', '-7 days')"
    ).get() as { count: number };
    const succeeded = this.db.prepare(
      "SELECT COUNT(*) AS count FROM fix_applications WHERE result = 'success' AND created_at >= datetime('now', '-7 days')"
    ).get() as { count: number };
    const applied = this.db.prepare(
      "SELECT COUNT(*) AS count FROM fix_applications WHERE result != 'skipped' AND created_at >= datetime('now', '-7 days')"
    ).get() as { count: number };
    return { errorsThisWeek: errors.count, fixesApplied: applied.count, fixesSucceeded: succeeded.count };
  }

  private mapRow(row: Record<string, unknown>): KnownFix {
    return {
      id: Number(row["id"]),
      errorPattern: String(row["error_pattern"] ?? ""),
      errorSubstring: String(row["error_substring"] ?? ""),
      fixDescription: String(row["fix_description"] ?? ""),
      successCount: Number(row["success_count"] ?? 0),
      failureCount: Number(row["failure_count"] ?? 0),
      lastAppliedAt: row["last_applied_at"] ? String(row["last_applied_at"]) : null,
      autoApply: Boolean(row["auto_apply"]),
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// WEEKLY REPORTER — Еженедельный отчёт админу
// ═══════════════════════════════════════════════════════════════

export class WeeklyReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReportAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly fixLearner: FixLearner,
  ) {}

  start(bot: TelegramBot, ownerId: number): void {
    if (this.timer || !ownerId) return;
    const MS_PER_WEEK = 7 * 24 * 60 * 60_000;
    this.timer = setInterval(async () => {
      const now = Date.now();
      if (now - this.lastReportAt < MS_PER_WEEK) return;
      this.lastReportAt = now;
      const report = this.buildReport();
      await bot.sendMessage(ownerId, report, { parse_mode: "HTML" }).catch(err => logger.warn({ err }, "WeeklyReporter send failed"));
    }, 60 * 60_000);
    this.timer.unref?.();
    logger.info({ ownerId }, "WeeklyReporter started (checks every hour, sends every 7 days)");
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  buildReport(): string {
    const uptime = process.uptime();
    const uptimePct = Math.min(100, (uptime / (7 * 24 * 3600)) * 100).toFixed(1);

    const weeklyErrors = this.db.prepare(
      "SELECT pattern, COUNT(*) AS count FROM error_events WHERE created_at >= datetime('now', '-7 days') GROUP BY pattern ORDER BY count DESC LIMIT 5"
    ).all() as Array<{ pattern: string; count: number }>;

    const weeklyFixes = this.db.prepare(
      "SELECT type, COUNT(*) AS count FROM fixes WHERE created_at >= datetime('now', '-7 days') AND rolled_back = 0 GROUP BY type"
    ).all() as Array<{ type: string; count: number }>;

    const totalErrors = weeklyErrors.reduce((s, r) => s + r.count, 0);
    const totalFixes = weeklyFixes.reduce((s, r) => s + r.count, 0);

    const { errorsThisWeek: learned, fixesApplied, fixesSucceeded } = this.fixLearner.getWeeklyStats();

    const topFixes = this.fixLearner.getTopFixes(3);

    const mem = process.memoryUsage();
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);

    const lines = [
      `📊 <b>Еженедельный отчёт CodeGuardian</b>`,
      ``,
      `⏱ <b>Аптайм:</b> ${Math.floor(uptime / 3600)}ч (${uptimePct}% за неделю)`,
      `💾 <b>RAM сейчас:</b> ${heapMb} МБ`,
      ``,
      `🛡 <b>Перехваченные ошибки:</b> ${totalErrors}`,
      weeklyErrors.length
        ? weeklyErrors.map(r => `  • ${escapeHtml(r.pattern)}: ${r.count}×`).join("\n")
        : "  (нет ошибок — отличная неделя!)",
      ``,
      `🔧 <b>Автофиксы применены:</b> ${totalFixes}`,
      weeklyFixes.length
        ? weeklyFixes.map(r => `  • ${escapeHtml(r.type)}: ${r.count}×`).join("\n")
        : "  (нет фиксов)",
      ``,
      `🧠 <b>FixLearner:</b> ${learned} событий, применено ${fixesApplied} известных фиксов, успешно ${fixesSucceeded}`,
      topFixes.length
        ? `Топ паттерны:\n` + topFixes.map(f => `  • <code>${escapeHtml(f.errorPattern)}</code> — ${f.successCount} успешных исправлений`).join("\n")
        : "",
      ``,
      `<i>Команды: /status /memory_stats /analyze /rollback</i>`,
    ].filter(l => l !== undefined);

    return lines.join("\n");
  }

  buildReportNow(): string {
    return this.buildReport();
  }
}
