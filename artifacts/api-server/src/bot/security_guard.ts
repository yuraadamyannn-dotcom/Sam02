import { DatabaseSync } from "node:sqlite";
import { logger } from "../lib/logger";

function nowIso(): string {
  return new Date().toISOString();
}

// ═══════════════════════════════════════════════════════════════
// SECURITY GUARD — Input validation, injection protection, blacklist
// ═══════════════════════════════════════════════════════════════

export type ViolationType =
  | "injection"
  | "flood"
  | "overflow"
  | "binary_data"
  | "control_chars"
  | "abuse"
  | "blacklist_trigger";

export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason?: string;
  truncated?: boolean;
  injectionDetected?: boolean;
}

export interface SecurityStats {
  totalViolations: number;
  blacklistedUsers: number;
  recentInjections: number;
  recentFloods: number;
  recentOverflows: number;
}

// ── Prompt injection patterns ──────────────────────────────────
// Patterns that attempt to override the bot's persona or system prompt
const INJECTION_PATTERNS: RegExp[] = [
  /игнори(руй|руйте)\s*(все|предыдущие|системн|инструкци)/i,
  /new\s+instruction[s:]/i,
  /forget\s+(all\s+)?previous\s+(instructions?|prompts?)/i,
  /you\s+are\s+now\s+(?:a|an)\s+\w/i,
  /act\s+as\s+(?:a|an|if)\s/i,
  /system\s*:/i,
  /\[system\]/i,
  /<\s*system\s*>/i,
  /\|\|system\s*prompt/i,
  /игнор.*инструк/i,
  /притворись\s+(что\s+)?ты/i,
  /ты\s+теперь\s+(?:не|другой|новый)/i,
  /выйди\s+из\s+роли/i,
  /забудь\s+(?:все|свои|предыдущие)/i,
  /отключи\s+(?:все\s+)?ограничени/i,
  /твои\s+правила\s+(?:были|теперь|изменились)/i,
  /DAN\s+mode/i,
  /jailbreak/i,
  /prompt\s+injection/i,
  /\bDo\s+Anything\s+Now\b/i,
];

// ── Flood detection: same-message deduplication per user ────────
interface FloodEntry { text: string; count: number; firstSeen: number; }
const floodMap = new Map<number, FloodEntry>();
const FLOOD_THRESHOLD = 3;
const FLOOD_WINDOW_MS = 60_000;

export class SecurityGuard {
  constructor(private readonly db: DatabaseSync) {
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS security_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT NOT NULL,
        snippet TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_blacklist (
        user_id INTEGER PRIMARY KEY,
        reason TEXT NOT NULL,
        violation_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS security_stats_hourly (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour TEXT NOT NULL,
        violations INTEGER NOT NULL DEFAULT 0,
        injections INTEGER NOT NULL DEFAULT 0,
        floods INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sec_violations_user ON security_violations(user_id, created_at);
    `);
  }

  // ── Main entry point: sanitize + validate + check all threats ─
  sanitizeInput(text: string, userId?: number): SanitizeResult {
    // 1. Check blacklist first
    if (userId && this.isBlacklisted(userId)) {
      return { text: "", blocked: true, reason: "blacklisted" };
    }

    // 2. Strip null bytes and C0 control chars (except \n, \r, \t)
    let clean = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

    // 3. Detect binary data (non-printable density > 5%)
    const nonPrintable = (clean.match(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g) ?? []).length;
    if (nonPrintable / Math.max(clean.length, 1) > 0.05) {
      if (userId) this.recordViolation(userId, "binary_data", clean.slice(0, 80));
      return { text: "", blocked: true, reason: "binary_data" };
    }

    // 4. Length limit
    let truncated = false;
    if (clean.length > 4000) {
      clean = clean.slice(0, 4000);
      truncated = true;
      if (userId) this.recordViolation(userId, "overflow", `${text.length} chars`);
    }

    // 5. Flood detection
    if (userId && this.checkFlood(userId, clean)) {
      return { text: clean, blocked: true, reason: "flood", truncated };
    }

    // 6. Prompt injection detection
    const injectionDetected = this.detectInjection(clean);
    if (injectionDetected) {
      if (userId) this.recordViolation(userId, "injection", clean.slice(0, 120));
      // Don't block — return sanitized text and flag it so the AI layer can handle it
      const sanitized = this.neutralizeInjection(clean);
      return { text: sanitized, blocked: false, truncated, injectionDetected: true };
    }

    return { text: clean, blocked: false, truncated, injectionDetected: false };
  }

  detectInjection(text: string): boolean {
    return INJECTION_PATTERNS.some(re => re.test(text));
  }

  // Replace injection trigger phrases with harmless stand-ins
  private neutralizeInjection(text: string): string {
    let out = text;
    for (const re of INJECTION_PATTERNS) {
      out = out.replace(re, (m) => "[" + "?".repeat(Math.min(m.length, 8)) + "]");
    }
    return out;
  }

  // ── Flood detection ────────────────────────────────────────────
  checkFlood(userId: number, text: string): boolean {
    const now = Date.now();
    const normalized = text.trim().toLowerCase().slice(0, 200);
    const entry = floodMap.get(userId);

    if (!entry || now - entry.firstSeen > FLOOD_WINDOW_MS || entry.text !== normalized) {
      floodMap.set(userId, { text: normalized, count: 1, firstSeen: now });
      return false;
    }

    entry.count++;
    if (entry.count >= FLOOD_THRESHOLD) {
      this.recordViolation(userId, "flood", normalized.slice(0, 80));
      return true;
    }
    return false;
  }

  // ── Blacklist management ───────────────────────────────────────
  isBlacklisted(userId: number): boolean {
    const row = this.db.prepare("SELECT user_id FROM security_blacklist WHERE user_id = ?").get(userId);
    return !!row;
  }

  recordViolation(userId: number, type: ViolationType, snippet: string): void {
    this.db.prepare(
      "INSERT INTO security_violations (user_id, type, snippet, created_at) VALUES (?, ?, ?, ?)"
    ).run(userId, type, snippet.slice(0, 200), nowIso());

    // Auto-blacklist after 5 violations in 24 hours
    const recent = this.db.prepare(
      "SELECT COUNT(*) AS count FROM security_violations WHERE user_id = ? AND created_at >= datetime('now', '-24 hours')"
    ).get(userId) as { count: number };

    if (recent.count >= 5) {
      const exists = this.db.prepare("SELECT violation_count FROM security_blacklist WHERE user_id = ?").get(userId) as { violation_count: number } | undefined;
      if (exists) {
        this.db.prepare(
          "UPDATE security_blacklist SET violation_count = violation_count + 1, updated_at = ? WHERE user_id = ?"
        ).run(nowIso(), userId);
      } else {
        this.db.prepare(
          "INSERT INTO security_blacklist (user_id, reason, violation_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        ).run(userId, `auto: ${type} (${recent.count} violations/24h)`, recent.count, nowIso(), nowIso());
        logger.warn({ userId, violationType: type, count: recent.count }, "SecurityGuard: user auto-blacklisted");
      }
    }

    logger.warn({ userId, type, snippet: snippet.slice(0, 60) }, "SecurityGuard: violation recorded");
  }

  unblacklist(userId: number): boolean {
    const result = this.db.prepare("DELETE FROM security_blacklist WHERE user_id = ?").run(userId);
    return result.changes > 0;
  }

  // ── Periodic cleanup: remove old logs (privacy, >30 days) ─────
  cleanup(): void {
    this.db.prepare("DELETE FROM security_violations WHERE created_at < datetime('now', '-30 days')").run();
    // Clean stale flood entries from in-memory map
    const now = Date.now();
    for (const [uid, entry] of floodMap) {
      if (now - entry.firstSeen > FLOOD_WINDOW_MS * 5) floodMap.delete(uid);
    }
  }

  getStats(): SecurityStats {
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM security_violations").get() as { count: number };
    const blacklisted = this.db.prepare("SELECT COUNT(*) AS count FROM security_blacklist").get() as { count: number };
    const recentByType = this.db.prepare(
      "SELECT type, COUNT(*) AS count FROM security_violations WHERE created_at >= datetime('now', '-1 hour') GROUP BY type"
    ).all() as Array<{ type: string; count: number }>;

    const byType = Object.fromEntries(recentByType.map(r => [r.type, r.count]));
    return {
      totalViolations: total.count,
      blacklistedUsers: blacklisted.count,
      recentInjections: byType["injection"] ?? 0,
      recentFloods: byType["flood"] ?? 0,
      recentOverflows: byType["overflow"] ?? 0,
    };
  }

  getBlacklist(): Array<{ userId: number; reason: string; violationCount: number; createdAt: string }> {
    const rows = this.db.prepare("SELECT user_id, reason, violation_count, created_at FROM security_blacklist ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      userId: Number(r["user_id"]),
      reason: String(r["reason"] ?? ""),
      violationCount: Number(r["violation_count"] ?? 0),
      createdAt: String(r["created_at"] ?? ""),
    }));
  }
}
