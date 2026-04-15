import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

// ═══════════════════════════════════════════════════════════════
// REPLIT OPTIMIZER — Resource monitoring, graceful shutdown, keep-alive
// ═══════════════════════════════════════════════════════════════

export interface MemorySnapshot {
  heapUsedMb: number;
  heapTotalMb: number;
  rssMb: number;
  externalMb: number;
  pct: number;
}

export interface ResourceStatus {
  memory: MemorySnapshot;
  uptimeSeconds: number;
  highMemory: boolean;
  criticalMemory: boolean;
}

export class ReplitOptimizer {
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private selfPingTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownRegistered = false;
  private isShuttingDown = false;
  private onHighMemoryCb: (() => void) | null = null;
  private onCriticalMemoryCb: (() => void) | null = null;
  private alertCb: ((msg: string) => void) | null = null;
  private lastHighMemAlert = 0;

  private readonly HIGH_MEMORY_PCT = 0.70;    // 70% → clear soft caches
  private readonly CRITICAL_MEMORY_PCT = 0.85; // 85% → kill non-critical tasks

  start(opts: {
    selfPingUrl?: string;
    selfPingIntervalMs?: number;
    onHighMemory?: () => void;
    onCriticalMemory?: () => void;
    alertCallback?: (msg: string) => void;
  } = {}): void {
    this.onHighMemoryCb = opts.onHighMemory ?? null;
    this.onCriticalMemoryCb = opts.onCriticalMemory ?? null;
    this.alertCb = opts.alertCallback ?? null;

    // ── Memory monitor: every 30 seconds ───────────────────────
    if (!this.monitorTimer) {
      this.monitorTimer = setInterval(() => this.checkMemory(), 30_000);
      this.monitorTimer.unref?.();
    }

    // ── Self-ping keep-alive (prevents Replit free-tier sleep) ─
    if (opts.selfPingUrl && !this.selfPingTimer) {
      const pingUrl = opts.selfPingUrl;
      const interval = opts.selfPingIntervalMs ?? 5 * 60_000; // 5 minutes
      this.selfPingTimer = setInterval(async () => {
        try {
          const res = await fetch(pingUrl, { method: "GET", signal: AbortSignal.timeout(5_000) });
          logger.debug({ status: res.status }, "ReplitOptimizer: self-ping ok");
        } catch (err) {
          logger.warn({ err }, "ReplitOptimizer: self-ping failed");
        }
      }, interval);
      this.selfPingTimer.unref?.();
      logger.info({ pingUrl, interval }, "ReplitOptimizer: self-ping started");
    }

    logger.info("ReplitOptimizer: resource monitoring started");
  }

  checkMemory(): ResourceStatus {
    const mem = process.memoryUsage();
    const heapUsedMb = mem.heapUsed / 1024 / 1024;
    const heapTotalMb = mem.heapTotal / 1024 / 1024;
    const rssMb = mem.rss / 1024 / 1024;
    const externalMb = mem.external / 1024 / 1024;
    const pct = mem.heapUsed / mem.heapTotal;

    const highMemory = pct >= this.HIGH_MEMORY_PCT;
    const criticalMemory = pct >= this.CRITICAL_MEMORY_PCT;

    if (criticalMemory) {
      logger.error({ heapUsedMb: Math.round(heapUsedMb), pct: (pct * 100).toFixed(0) }, "ReplitOptimizer: CRITICAL memory");
      this.onCriticalMemoryCb?.();
      // Force GC if available
      if (global.gc) global.gc();
      const now = Date.now();
      if (now - this.lastHighMemAlert > 15 * 60_000) {
        this.lastHighMemAlert = now;
        this.alertCb?.(`🚨 <b>ReplitOptimizer: КРИТИЧЕСКАЯ память</b>\nHeap: <code>${Math.round(heapUsedMb)} MB / ${Math.round(heapTotalMb)} MB (${(pct * 100).toFixed(0)}%)</code>\nRSS: <code>${Math.round(rssMb)} MB</code>\nДействие: принудительный GC + очистка кэшей.`);
      }
    } else if (highMemory) {
      logger.warn({ heapUsedMb: Math.round(heapUsedMb), pct: (pct * 100).toFixed(0) }, "ReplitOptimizer: high memory");
      this.onHighMemoryCb?.();
      if (global.gc) global.gc();
    }

    return {
      memory: { heapUsedMb, heapTotalMb, rssMb, externalMb, pct },
      uptimeSeconds: process.uptime(),
      highMemory,
      criticalMemory,
    };
  }

  // ── Graceful shutdown handler ─────────────────────────────────
  setupGracefulShutdown(opts: {
    bot?: TelegramBot;
    adminChatId?: number;
    onShutdown?: () => Promise<void>;
    timeoutMs?: number;
  } = {}): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    const handler = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      logger.info({ signal }, "ReplitOptimizer: graceful shutdown initiated");

      // Notify admin if possible
      if (opts.bot && opts.adminChatId) {
        await opts.bot.sendMessage(opts.adminChatId, `⚙️ Бот получил сигнал <code>${signal}</code> — перезагружается...`, { parse_mode: "HTML" }).catch(() => {});
      }

      // Run user-defined cleanup with timeout
      const timeout = opts.timeoutMs ?? 10_000;
      if (opts.onShutdown) {
        await Promise.race([
          opts.onShutdown(),
          new Promise<void>(resolve => setTimeout(resolve, timeout)),
        ]).catch(err => logger.warn({ err }, "ReplitOptimizer: onShutdown errored"));
      }

      logger.info("ReplitOptimizer: shutdown complete");
      process.exit(0);
    };

    process.once("SIGTERM", () => void handler("SIGTERM"));
    process.once("SIGINT", () => void handler("SIGINT"));
    logger.info("ReplitOptimizer: graceful shutdown handlers registered (SIGTERM, SIGINT)");
  }

  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  stop(): void {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    if (this.selfPingTimer) { clearInterval(this.selfPingTimer); this.selfPingTimer = null; }
  }

  getStats(): Record<string, unknown> {
    const status = this.checkMemory();
    return {
      heapMb: Math.round(status.memory.heapUsedMb),
      heapTotalMb: Math.round(status.memory.heapTotalMb),
      rssMb: Math.round(status.memory.rssMb),
      pct: (status.memory.pct * 100).toFixed(1),
      uptimeH: (status.uptimeSeconds / 3600).toFixed(1),
      highMemory: status.highMemory,
      criticalMemory: status.criticalMemory,
      isShuttingDown: this.isShuttingDown,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// DEPENDENCY GUARD — Version verification at startup
// ═══════════════════════════════════════════════════════════════

export interface DependencyCheckResult {
  ok: boolean;
  checked: number;
  mismatches: Array<{ name: string; installed: string; expected: string }>;
  warnings: string[];
}

export class DependencyGuard {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot = process.cwd()) {
    // Walk up to find package.json with workspace deps
    this.workspaceRoot = workspaceRoot;
  }

  checkVersions(): DependencyCheckResult {
    const mismatches: Array<{ name: string; installed: string; expected: string }> = [];
    const warnings: string[] = [];
    let checked = 0;

    try {
      // Read this artifact's package.json
      const pkgPath = join(this.workspaceRoot, "package.json");
      if (!existsSync(pkgPath)) {
        return { ok: true, checked: 0, mismatches: [], warnings: ["package.json not found"] };
      }

      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Check a subset of critical packages
      const critical = ["node-telegram-bot-api", "express", "drizzle-orm", "groq-sdk", "@google/generative-ai", "openai", "elevenlabs"];
      for (const name of critical) {
        const expected = allDeps[name];
        if (!expected) continue;
        checked++;

        try {
          const installedPkgPath = join(this.workspaceRoot, "node_modules", name, "package.json");
          if (!existsSync(installedPkgPath)) {
            warnings.push(`${name}: not found in node_modules`);
            continue;
          }
          const installed = (JSON.parse(readFileSync(installedPkgPath, "utf8")) as { version?: string }).version ?? "unknown";
          const expectedClean = expected.replace(/^[\^~>=<]/, "");

          // Simple major version check
          const installedMajor = parseInt(installed.split(".")[0] ?? "0");
          const expectedMajor = parseInt(expectedClean.split(".")[0] ?? "0");
          if (!isNaN(installedMajor) && !isNaN(expectedMajor) && installedMajor !== expectedMajor) {
            mismatches.push({ name, installed, expected: expectedClean });
          }
        } catch {
          warnings.push(`${name}: could not read installed version`);
        }
      }

      if (mismatches.length) {
        logger.warn({ mismatches }, "DependencyGuard: version mismatches found");
      } else {
        logger.info({ checked }, "DependencyGuard: all critical dependencies OK");
      }
    } catch (err) {
      warnings.push(`DependencyGuard error: ${String(err)}`);
    }

    return { ok: mismatches.length === 0, checked, mismatches, warnings };
  }
}

// ── Priority message queue for outgoing Telegram messages ──────
export type MessagePriority = "admin" | "error" | "reply" | "proactive";

interface QueuedMessage {
  chatId: number;
  text: string;
  priority: MessagePriority;
  opts?: Record<string, unknown>;
  enqueuedAt: number;
  attempts: number;
}

const PRIORITY_ORDER: Record<MessagePriority, number> = { admin: 0, error: 1, reply: 2, proactive: 3 };

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private flushing = false;
  private bot: TelegramBot | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxQueueSize: number;

  constructor(maxQueueSize = 500) {
    this.maxQueueSize = maxQueueSize;
  }

  attach(bot: TelegramBot): void {
    this.bot = bot;
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flush(), 200);
      this.flushTimer.unref?.();
    }
  }

  enqueue(chatId: number, text: string, priority: MessagePriority, opts?: Record<string, unknown>): void {
    // Drop proactive messages when queue is large
    if (this.queue.length >= this.maxQueueSize && priority === "proactive") {
      logger.warn({ queueSize: this.queue.length }, "MessageQueue: dropping proactive message (queue full)");
      return;
    }
    this.queue.push({ chatId, text, priority, opts, enqueuedAt: Date.now(), attempts: 0 });
    // Sort by priority
    this.queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.bot || this.queue.length === 0) return;
    this.flushing = true;
    try {
      const msg = this.queue.shift();
      if (!msg) return;
      // Drop stale proactive messages (> 2 min old)
      if (msg.priority === "proactive" && Date.now() - msg.enqueuedAt > 2 * 60_000) return;
      await this.bot.sendMessage(msg.chatId, msg.text, msg.opts as TelegramBot.SendMessageOptions).catch(err => {
        msg.attempts++;
        if (msg.attempts < 3 && msg.priority !== "proactive") this.queue.unshift(msg); // re-queue non-proactive
        logger.warn({ err, chatId: msg.chatId, attempts: msg.attempts }, "MessageQueue: send failed");
      });
    } finally {
      this.flushing = false;
    }
  }

  getStats(): { queued: number; breakdown: Record<string, number> } {
    const breakdown: Record<string, number> = { admin: 0, error: 0, reply: 0, proactive: 0 };
    for (const m of this.queue) breakdown[m.priority] = (breakdown[m.priority] ?? 0) + 1;
    return { queued: this.queue.length, breakdown };
  }

  stop(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }
}
