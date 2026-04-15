import { DatabaseSync } from "node:sqlite";
import { logger } from "../lib/logger";

function nowIso(): string {
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════
// DATA INTEGRITY — Vector validation, DB checks, audit trail
// ═══════════════════════════════════════════════════════════════

export interface VectorValidationResult {
  valid: boolean;
  issues: string[];
  fixed?: number[];
}

export interface MetadataValidationResult {
  valid: boolean;
  missing: string[];
  fixed: Record<string, unknown>;
}

export interface IntegrityCheckResult {
  ok: boolean;
  issues: string[];
  vacuumed?: boolean;
  vacuumSavedMb?: number;
}

export class DataIntegrity {
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private alertCallback: ((msg: string) => void) | null = null;

  constructor(private readonly db: DatabaseSync) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integrity_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        target TEXT NOT NULL,
        result TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integrity_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_type TEXT NOT NULL,
        status TEXT NOT NULL,
        issues_found INTEGER NOT NULL DEFAULT 0,
        fixed INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  setAlertCallback(cb: (msg: string) => void): void {
    this.alertCallback = cb;
  }

  // ── Vector validation ──────────────────────────────────────────
  validateVector(vector: number[], expectedDim: number): VectorValidationResult {
    const issues: string[] = [];

    if (!Array.isArray(vector) || vector.length === 0) {
      return { valid: false, issues: ["vector is empty or not an array"] };
    }

    if (vector.length !== expectedDim) {
      issues.push(`dimension mismatch: got ${vector.length}, expected ${expectedDim}`);
    }

    let hasNaN = false;
    let hasInf = false;
    let allZero = true;
    let fixedVec = [...vector];

    for (let i = 0; i < fixedVec.length; i++) {
      const v = fixedVec[i]!;
      if (Number.isNaN(v)) { hasNaN = true; fixedVec[i] = 0; }
      else if (!Number.isFinite(v)) { hasInf = true; fixedVec[i] = v > 0 ? 1 : -1; }
      else if (v !== 0) allZero = false;
    }

    if (hasNaN) issues.push("vector contains NaN values (replaced with 0)");
    if (hasInf) issues.push("vector contains Inf values (clamped)");
    if (allZero) issues.push("vector is all-zeros (embedding may have failed)");

    // Pad or trim if dimension mismatch
    if (fixedVec.length < expectedDim) {
      fixedVec = [...fixedVec, ...new Array(expectedDim - fixedVec.length).fill(0)];
    } else if (fixedVec.length > expectedDim) {
      fixedVec = fixedVec.slice(0, expectedDim);
    }

    return { valid: issues.length === 0, issues, fixed: issues.length > 0 ? fixedVec : undefined };
  }

  // ── Metadata validation ────────────────────────────────────────
  validateMetadata(
    meta: Record<string, unknown>,
    required: string[] = ["user_id", "timestamp"],
  ): MetadataValidationResult {
    const missing: string[] = [];
    const fixed: Record<string, unknown> = { ...meta };

    for (const field of required) {
      if (!(field in fixed) || fixed[field] === null || fixed[field] === undefined) {
        missing.push(field);
        // Auto-fill defaults
        if (field === "timestamp") fixed[field] = Date.now();
        if (field === "user_id") fixed[field] = 0;
      }
    }

    return { valid: missing.length === 0, missing, fixed };
  }

  // ── SQLite PRAGMA integrity_check ──────────────────────────────
  runIntegrityCheck(): IntegrityCheckResult {
    const issues: string[] = [];
    try {
      const rows = this.db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
      const errors = rows.filter(r => r.integrity_check !== "ok").map(r => r.integrity_check);
      if (errors.length) {
        issues.push(...errors);
        logger.error({ errors }, "DataIntegrity: SQLite integrity check failed");
        this.alertCallback?.(`🚨 <b>DataIntegrity: SQLite повреждён</b>\n${errors.slice(0, 5).join("\n")}`);
      }
    } catch (err) {
      issues.push(String(err));
    }

    this.db.prepare("INSERT INTO integrity_checks (check_type, status, issues_found, created_at) VALUES (?, ?, ?, ?)")
      .run("sqlite_integrity", issues.length === 0 ? "ok" : "failed", issues.length, nowIso());

    return { ok: issues.length === 0, issues };
  }

  // ── SQLite VACUUM: run if size > thresholdMb ───────────────────
  runVacuumIfNeeded(thresholdMb = 50): { vacuumed: boolean; savedMb: number } {
    try {
      const sizeRow = this.db.prepare("PRAGMA page_count").get() as { page_count: number } | undefined;
      const pageSizeRow = this.db.prepare("PRAGMA page_size").get() as { page_size: number } | undefined;
      const sizeMb = ((sizeRow?.page_count ?? 0) * (pageSizeRow?.page_size ?? 4096)) / (1024 * 1024);

      if (sizeMb < thresholdMb) return { vacuumed: false, savedMb: 0 };

      logger.info({ sizeMb, thresholdMb }, "DataIntegrity: running VACUUM");
      this.db.exec("VACUUM");

      const afterRow = this.db.prepare("PRAGMA page_count").get() as { page_count: number } | undefined;
      const afterMb = ((afterRow?.page_count ?? 0) * (pageSizeRow?.page_size ?? 4096)) / (1024 * 1024);
      const savedMb = Math.max(0, sizeMb - afterMb);

      logger.info({ savedMb }, "DataIntegrity: VACUUM complete");
      this.db.prepare("INSERT INTO integrity_checks (check_type, status, issues_found, notes, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("vacuum", "ok", 0, `saved ${savedMb.toFixed(1)} MB`, nowIso());

      return { vacuumed: true, savedMb };
    } catch (err) {
      logger.warn({ err }, "DataIntegrity: VACUUM failed");
      return { vacuumed: false, savedMb: 0 };
    }
  }

  // ── Clean stale entries from optional sync_queue table ────────
  // Only works when the db has a sync_queue table (hybrid_memory guardian db).
  // Silently returns 0 when the table doesn't exist (safe for code_guardian db).
  cleanSyncQueue(): number {
    try {
      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_queue'"
      ).get();
      if (!tableExists) return 0;
      const result = this.db.prepare(
        "DELETE FROM sync_queue WHERE created_at < datetime('now', '-7 days') AND attempts >= 3"
      ).run();
      if (result.changes > 0) logger.info({ deleted: result.changes }, "DataIntegrity: cleaned stale sync queue entries");
      return result.changes;
    } catch {
      return 0;
    }
  }

  // ── Archive old memory logs (optional memory_logs table) ─────
  archiveOldLogs(): number {
    try {
      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_logs'"
      ).get();
      if (!tableExists) return 0;
      const result = this.db.prepare("DELETE FROM memory_logs WHERE created_at < datetime('now', '-30 days')").run();
      return result.changes;
    } catch {
      return 0;
    }
  }

  // ── Audit trail ────────────────────────────────────────────────
  audit(operation: string, target: string, result: string, notes?: string): void {
    this.db.prepare(
      "INSERT INTO integrity_audit (operation, target, result, notes, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(operation, target, result, notes ?? null, nowIso());
  }

  // ── Full periodic check (every 24 hours) ─────────────────────
  runFullCheck(): IntegrityCheckResult {
    const result = this.runIntegrityCheck();
    const { vacuumed, savedMb } = this.runVacuumIfNeeded(50);
    const cleaned = this.cleanSyncQueue();
    const archivedLogs = this.archiveOldLogs();

    const notes = [
      vacuumed ? `VACUUM saved ${savedMb.toFixed(1)} MB` : null,
      cleaned > 0 ? `cleaned ${cleaned} stale queue entries` : null,
      archivedLogs > 0 ? `archived ${archivedLogs} old log entries` : null,
    ].filter(Boolean).join("; ");

    if (notes) logger.info({ notes }, "DataIntegrity: full check completed");

    return { ...result, vacuumed, vacuumSavedMb: savedMb };
  }

  // ── Start periodic checks every 24 hours ─────────────────────
  start(alertCb?: (msg: string) => void): void {
    if (alertCb) this.alertCallback = alertCb;
    if (this.checkTimer) return;

    // First check 2 minutes after start
    setTimeout(() => {
      const result = this.runFullCheck();
      if (!result.ok) {
        this.alertCallback?.(`⚠️ <b>DataIntegrity: найдены проблемы при старте</b>\n${result.issues.slice(0, 3).join("\n")}`);
      }
    }, 2 * 60_000);

    this.checkTimer = setInterval(() => {
      try {
        const result = this.runFullCheck();
        if (!result.ok) {
          this.alertCallback?.(`⚠️ <b>DataIntegrity: проблемы целостности</b>\n${result.issues.slice(0, 3).join("\n")}`);
        }
      } catch (err) {
        logger.warn({ err }, "DataIntegrity: periodic check failed");
      }
    }, 24 * 60 * 60_000);
    this.checkTimer.unref?.();

    logger.info("DataIntegrity: periodic checks started (every 24h + startup check)");
  }

  stop(): void {
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
  }

  getStats(): Record<string, unknown> {
    const lastChecks = this.db.prepare(
      "SELECT check_type, status, issues_found, notes, created_at FROM integrity_checks ORDER BY created_at DESC LIMIT 10"
    ).all();
    const auditCount = this.db.prepare("SELECT COUNT(*) AS count FROM integrity_audit").get() as { count: number };
    return { recentChecks: lastChecks, auditEntries: auditCount.count };
  }
}
