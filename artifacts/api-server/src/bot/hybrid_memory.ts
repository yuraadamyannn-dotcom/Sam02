import { existsSync, mkdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import OpenAI from "openai";
import { logger } from "../lib/logger";
import { AutoScaler } from "./predictive_guard";

export type MemoryType = "dialog" | "song" | "profile" | "old_dialog" | "event" | "voice_transcript" | string;

type ExternalTarget = "qdrant" | "zilliz";

type ClientStatus = "healthy" | "degraded" | "dead" | "disabled";

export interface MemoryEntry {
  id: string;
  userId?: number;
  chatId?: number;
  text: string;
  type: MemoryType;
  score?: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface ClientMetrics {
  status: ClientStatus;
  latencyMs: number;
  errors: number;
  consecutiveErrors: number;
  lastError?: string;
  circuitOpenUntil: number;
  configured: boolean;
}

const GUARDIAN_DB_PATH = "/mnt/data/memory_guardian.db";
const EMBEDDING_DIM = process.env["OPENAI_API_KEY"] ? 1536 : Number(process.env["LOCAL_EMBEDDING_DIM"] ?? 384);
const HOT_DAYS = 7;

function nowIso(): string {
  return new Date().toISOString();
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normaliseVector(vector: number[], dimensions: number): number[] {
  if (vector.length === dimensions) return vector;
  if (vector.length > dimensions) return vector.slice(0, dimensions);
  return [...vector, ...Array.from({ length: dimensions - vector.length }, () => 0)];
}

function resolveSqlitePath(requestedPath: string): string {
  const dir = requestedPath.substring(0, requestedPath.lastIndexOf("/"));
  try {
    mkdirSync(dir, { recursive: true });
    return requestedPath;
  } catch (err) {
    const fallback = `${process.cwd()}/.data/${requestedPath.split("/").pop()}`;
    mkdirSync(`${process.cwd()}/.data`, { recursive: true });
    logger.warn({ err, requestedPath, fallback }, "SQLite guardian path unavailable, using workspace fallback");
    return fallback;
  }
}

function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function hashEmbedding(text: string, dimensions = 384): number[] {
  const out = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
  const source = tokens.length ? tokens : [text || "empty"];
  for (const token of source) {
    const digest = createHash("sha256").update(token).digest();
    for (let i = 0; i < digest.length; i += 2) {
      const idx = digest[i]! % dimensions;
      const sign = digest[i + 1]! % 2 === 0 ? 1 : -1;
      out[idx] += sign * (1 + token.length / 20);
    }
  }
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
  return out.map(v => Number((v / norm).toFixed(6)));
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export class ResilientClient {
  private consecutiveErrors = 0;
  private errors = 0;
  private latencyMs = 0;
  private circuitOpenUntil = 0;
  private lastError: string | undefined;

  constructor(
    private readonly name: ExternalTarget,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  get status(): ClientStatus {
    if (!this.configured) return "disabled";
    if (Date.now() < this.circuitOpenUntil) return "dead";
    return this.consecutiveErrors > 0 ? "degraded" : "healthy";
  }

  getMetrics(): ClientMetrics {
    return {
      status: this.status,
      latencyMs: this.latencyMs,
      errors: this.errors,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
      circuitOpenUntil: this.circuitOpenUntil,
      configured: this.configured,
    };
  }

  async request<T>(label: string, path: string, init: RequestInit = {}): Promise<T> {
    if (!this.configured) throw new Error(`${this.name} is not configured`);
    if (Date.now() < this.circuitOpenUntil) throw new Error(`${this.name} circuit breaker is open`);

    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    headers.set("accept", headers.get("accept") ?? "application/json");
    if (this.name === "qdrant") headers.set("api-key", this.apiKey);
    else headers.set("authorization", `Bearer ${this.apiKey}`);

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now();
      try {
        const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(10_000) });
        this.latencyMs = Date.now() - started;
        if (!res.ok) throw new Error(`${this.name} ${label} failed: ${res.status} ${await res.text().catch(() => "")}`);
        this.consecutiveErrors = 0;
        this.lastError = undefined;
        if (res.status === 204) return undefined as T;
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) return await res.text() as T;
        return await res.json() as T;
      } catch (err) {
        lastErr = err;
        this.errors++;
        this.consecutiveErrors++;
        this.lastError = String(err);
        logger.warn({ err, target: this.name, label, attempt }, "Vector memory client request failed");
        if (this.consecutiveErrors >= 5) {
          this.circuitOpenUntil = Date.now() + 60_000;
          logger.error({ target: this.name, openUntil: this.circuitOpenUntil }, "Vector memory circuit breaker opened");
          break;
        }
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async healthCheck(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      if (this.name === "qdrant") {
        await this.request("health", "/healthz", { method: "GET" });
      } else {
        await this.request("health", "/v2/vectordb/collections/list", { method: "POST", body: JSON.stringify({}) });
      }
      this.consecutiveErrors = 0;
      return true;
    } catch {
      return false;
    }
  }
}

export class MemoryGuardian {
  private db: DatabaseSync;
  private recentOps: MemoryEntry[] = [];
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dbPath = GUARDIAN_DB_PATH) {
    this.dbPath = resolveSqlitePath(dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guardian_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
      CREATE TABLE IF NOT EXISTS profile_cache (user_id INTEGER PRIMARY KEY, data_json TEXT NOT NULL, updated_at TEXT NOT NULL, last_access TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dialog_buffer (id TEXT PRIMARY KEY, user_id INTEGER, chat_id INTEGER, text TEXT NOT NULL, type TEXT NOT NULL, vector_json TEXT NOT NULL, created_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT NOT NULL, operation TEXT NOT NULL, latency_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_cache (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, created_at TEXT NOT NULL, last_access TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, message TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS distributed_locks (resource_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_dialog_buffer_chat_ts ON dialog_buffer(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_dialog_buffer_user_ts ON dialog_buffer(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sync_queue_target ON sync_queue(target, created_at);
    `);
  }

  async withLock<T>(resourceId: string, work: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    const owner = randomUUID();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.db.prepare("DELETE FROM distributed_locks WHERE expires_at < ?").run(Date.now());
      const result = this.db.prepare("INSERT OR IGNORE INTO distributed_locks (resource_id, owner, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(resourceId, owner, Date.now() + 30_000, nowIso());
      if (result.changes === 1) {
        const started = Date.now();
        try {
          return await work();
        } finally {
          const elapsed = Date.now() - started;
          if (elapsed > 5000) this.log("warn", "long distributed lock", { resourceId, elapsed });
          this.db.prepare("DELETE FROM distributed_locks WHERE resource_id = ? AND owner = ?").run(resourceId, owner);
        }
      }
      await sleep(100);
    }
    throw new Error(`lock timeout: ${resourceId}`);
  }

  setState(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO guardian_state (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), nowIso());
  }

  enqueue(target: ExternalTarget, operation: string, payload: unknown): void {
    this.db.prepare("INSERT INTO sync_queue (target, operation, payload, created_at) VALUES (?, ?, ?, ?)").run(target, operation, JSON.stringify(payload), nowIso());
  }

  getQueued(limit = 50): Array<{ id: number; target: ExternalTarget; operation: string; payload: Record<string, unknown>; attempts: number }> {
    const rows = this.db.prepare("SELECT id, target, operation, payload, attempts FROM sync_queue ORDER BY created_at ASC LIMIT ?").all(limit) as Array<{ id: number; target: ExternalTarget; operation: string; payload: string; attempts: number }>;
    return rows.map(row => ({ id: row.id, target: row.target, operation: row.operation, attempts: row.attempts, payload: safeJsonParse(row.payload, {}) }));
  }

  markSynced(id: number): void {
    this.db.prepare("DELETE FROM sync_queue WHERE id = ?").run(id);
  }

  markSyncFailed(id: number, err: unknown): void {
    this.db.prepare("UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?").run(String(err), id);
  }

  bufferDialog(entry: MemoryEntry, vector: number[], synced = false): void {
    this.recentOps.push(entry);
    if (this.recentOps.length > 1000) this.recentOps.splice(0, this.recentOps.length - 1000);
    this.db.prepare("INSERT OR REPLACE INTO dialog_buffer (id, user_id, chat_id, text, type, vector_json, created_at, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.id, entry.userId ?? null, entry.chatId ?? null, entry.text, entry.type, JSON.stringify(vector), new Date(entry.timestamp).toISOString(), synced ? 1 : 0);
  }

  getDialogBuffer(chatId: number, days = 7, limit = 50): MemoryEntry[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const rows = this.db.prepare("SELECT id, user_id, chat_id, text, type, created_at FROM dialog_buffer WHERE chat_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?")
      .all(chatId, since, limit) as Array<{ id: string; user_id: number | null; chat_id: number | null; text: string; type: string; created_at: string }>;
    return rows.map(row => ({ id: row.id, userId: row.user_id ?? undefined, chatId: row.chat_id ?? undefined, text: row.text, type: row.type, timestamp: Date.parse(row.created_at) }));
  }

  cacheProfile(userId: number, data: Record<string, unknown>): void {
    this.db.prepare("INSERT OR REPLACE INTO profile_cache (user_id, data_json, updated_at, last_access) VALUES (?, ?, ?, ?)")
      .run(userId, JSON.stringify(data), nowIso(), nowIso());
    this.db.prepare("DELETE FROM profile_cache WHERE user_id NOT IN (SELECT user_id FROM profile_cache ORDER BY last_access DESC LIMIT 1000)").run();
  }

  getCachedProfile(userId: number): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT data_json FROM profile_cache WHERE user_id = ?").get(userId) as { data_json: string } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE profile_cache SET last_access = ? WHERE user_id = ?").run(nowIso(), userId);
    return safeJsonParse(row.data_json, null as Record<string, unknown> | null);
  }

  // ── Embedding cache: avoid repeated OpenAI calls for same text ─
  getCachedEmbedding(cacheKey: string): number[] | null {
    try {
      const row = this.db.prepare("SELECT value_json FROM request_cache WHERE key = ?").get(`emb:${cacheKey}`) as { value_json: string } | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE request_cache SET last_access = ? WHERE key = ?").run(nowIso(), `emb:${cacheKey}`);
      return safeJsonParse(row.value_json, null as number[] | null);
    } catch { return null; }
  }

  setCachedEmbedding(cacheKey: string, vector: number[]): void {
    try {
      this.db.prepare("INSERT OR REPLACE INTO request_cache (key, value_json, created_at, last_access) VALUES (?, ?, ?, ?)")
        .run(`emb:${cacheKey}`, JSON.stringify(vector), nowIso(), nowIso());
      // Keep only 5000 most recent embedding entries
      this.db.prepare("DELETE FROM request_cache WHERE key LIKE 'emb:%' AND key NOT IN (SELECT key FROM request_cache WHERE key LIKE 'emb:%' ORDER BY last_access DESC LIMIT 5000)").run();
    } catch { /* non-critical */ }
  }

  recordMetric(component: string, operation: string, latencyMs: number, ok: boolean, error?: unknown): void {
    this.db.prepare("INSERT INTO metrics (component, operation, latency_ms, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(component, operation, Math.round(latencyMs), ok ? 1 : 0, error ? String(error) : null, nowIso());
  }

  log(level: string, message: string, meta: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO memory_logs (level, message, meta_json, created_at) VALUES (?, ?, ?, ?)")
      .run(level, message, JSON.stringify(meta), nowIso());
  }

  getDbSizeBytes(): number {
    try {
      return existsSync(this.dbPath) ? statSync(this.dbPath).size : 0;
    } catch {
      return 0;
    }
  }

  estimateExternalStorageMb(): { qdrantMb: number; zillizMb: number } {
    // Each vector point ≈ 2 KB (vector float32 array + payload + index overhead)
    const BYTES_PER_POINT = 2048;
    const dialogCount = (this.db.prepare("SELECT COUNT(*) AS count FROM dialog_buffer").get() as { count: number }).count;
    const profileCount = (this.db.prepare("SELECT COUNT(*) AS count FROM profile_cache").get() as { count: number }).count;
    // Qdrant holds active dialogs
    const qdrantMb = (dialogCount * BYTES_PER_POINT) / (1024 * 1024);
    // Zilliz holds profiles + archived dialogs (estimate 20% of dialogs are archive)
    const zillizMb = ((profileCount + Math.floor(dialogCount * 0.2)) * BYTES_PER_POINT) / (1024 * 1024);
    return { qdrantMb, zillizMb };
  }

  getStats(): Record<string, unknown> {
    const sync = this.db.prepare("SELECT COUNT(*) AS count FROM sync_queue").get() as { count: number };
    const buffered = this.db.prepare("SELECT COUNT(*) AS count FROM dialog_buffer WHERE synced = 0").get() as { count: number };
    const profiles = this.db.prepare("SELECT COUNT(*) AS count FROM profile_cache").get() as { count: number };
    const metrics = this.db.prepare("SELECT component, AVG(latency_ms) AS avg_latency, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors, COUNT(*) AS total FROM metrics WHERE created_at >= datetime('now', '-1 hour') GROUP BY component").all() as Array<Record<string, unknown>>;
    return { dbPath: this.dbPath, syncQueue: sync.count, bufferedDialogs: buffered.count, cachedProfiles: profiles.count, recentOps: this.recentOps.length, metrics };
  }

  startHealthLoop(clients: ResilientClient[]): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void Promise.all(clients.map(async client => {
        const started = Date.now();
        const ok = await client.healthCheck();
        this.recordMetric(client.getMetrics().configured ? "vector" : "vector_disabled", `${client.getMetrics().status}_health`, Date.now() - started, ok);
        this.setState(`${client.getMetrics().configured ? "configured" : "disabled"}_${Date.now()}`, clients.map(c => c.getMetrics()));
      })).catch(err => logger.warn({ err }, "Memory health loop failed"));
    }, 30_000);
    this.healthTimer.unref?.();
  }
}

export class HybridMemory {
  private guardian = new MemoryGuardian();
  private qdrant = new ResilientClient("qdrant", normaliseBaseUrl(process.env["QDRANT_URL"] ?? ""), process.env["QDRANT_API_KEY"] ?? "");
  private zilliz = new ResilientClient("zilliz", normaliseBaseUrl(process.env["ZILLIZ_URL"] ?? process.env["ZILLIZ_URI"] ?? ""), process.env["ZILLIZ_API_KEY"] ?? process.env["ZILLIZ_TOKEN"] ?? "");
  private openai = process.env["OPENAI_API_KEY"] ? new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] }) : null;
  private pending: Array<{ entry: MemoryEntry; vector: number[] }> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private migrationTimer: ReturnType<typeof setInterval> | null = null;
  private autoscaleTimer: ReturnType<typeof setInterval> | null = null;
  private profileHotCache = new Map<number, { data: Record<string, unknown>; expiresAt: number }>();
  private economyMode = false;
  private sqliteOnly = false;
  private zillizBlocked = false;
  private alertCallback: ((msg: string) => void) | null = null;
  private readonly autoScaler = new AutoScaler();

  setAlertCallback(cb: (msg: string) => void): void {
    this.alertCallback = cb;
  }

  start(): void {
    this.guardian.startHealthLoop([this.qdrant, this.zilliz]);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flushBatch().catch(err => logger.error({ err }, "Memory batch flush failed")), 5_000);
      this.flushTimer.unref?.();
    }
    if (!this.syncTimer) {
      this.syncTimer = setInterval(() => void this.syncQueued().catch(err => logger.error({ err }, "Memory sync failed")), 15_000);
      this.syncTimer.unref?.();
    }
    if (!this.migrationTimer) {
      this.migrationTimer = setInterval(() => void this.migrateColdData().catch(err => logger.error({ err }, "Memory migration failed")), 6 * 60 * 60_000);
      this.migrationTimer.unref?.();
    }
    if (!this.autoscaleTimer) {
      this.autoscaleTimer = setInterval(() => void this.autoscale().catch(err => logger.warn({ err }, "Memory autoscaler failed")), 10 * 60_000);
      this.autoscaleTimer.unref?.();
      setTimeout(() => void this.autoscale().catch(err => logger.warn({ err }, "Startup memory autoscaler failed")), 15_000).unref?.();
    }
  }

  async remember(userId: number, chatId: number, text: string, type: MemoryType = "dialog"): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.guardian.withLock(`memory:user:${userId}`, async () => {
      const entry: MemoryEntry = { id: randomUUID(), userId, chatId, text: trimmed.slice(0, 4000), type, timestamp: Date.now() };
      const vector = await this.embed(trimmed);
      this.guardian.bufferDialog(entry, vector, false);
      this.pending.push({ entry, vector });
      if (this.pending.length >= 10) await this.flushBatch();
    });
  }

  async recall(userId: number, chatId: number, query?: string, limit = 5): Promise<MemoryEntry[]> {
    const started = Date.now();
    const local = this.guardian.getDialogBuffer(chatId, HOT_DAYS, limit).filter(e => !userId || e.userId === userId || e.type === "event");
    if (!query) return local.slice(0, limit);
    const vector = await this.embed(query);
    const remote: MemoryEntry[] = [];
    if (this.qdrant.status !== "dead" && this.qdrant.configured) {
      remote.push(...await this.searchQdrant(`active_dialogs_${chatId}`, vector, limit).catch(() => []));
    }
    if (this.zilliz.status !== "dead" && this.zilliz.configured) {
      remote.push(...await this.searchZilliz("archive_data", vector, limit, { user_id: userId }).catch(() => []));
    }
    this.guardian.recordMetric("hybrid_memory", "recall", Date.now() - started, true);
    return [...remote, ...local].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.timestamp - a.timestamp).slice(0, limit);
  }

  async search_songs(query: string, limit = 5): Promise<MemoryEntry[]> {
    const vector = await this.embed(query);
    const remote = this.qdrant.configured ? await this.searchQdrant("song_index", vector, limit).catch(() => []) : [];
    return remote.slice(0, limit);
  }

  async get_profile(userId: number): Promise<Record<string, unknown> | null> {
    const cached = this.profileHotCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    const local = this.guardian.getCachedProfile(userId);
    if (local) {
      this.profileHotCache.set(userId, { data: local, expiresAt: Date.now() + 5 * 60_000 });
      return local;
    }
    if (!this.zilliz.configured || this.zilliz.status === "dead") return null;
    const vector = hashEmbedding(`profile ${userId}`, EMBEDDING_DIM);
    const [profile] = await this.searchZilliz("user_profiles", vector, 1, { user_id: userId }).catch(() => []);
    if (!profile?.metadata) return null;
    this.guardian.cacheProfile(userId, profile.metadata);
    return profile.metadata;
  }

  async update_profile(userId: number, data: Record<string, unknown>): Promise<void> {
    await this.guardian.withLock(`profile:${userId}`, async () => {
      const payload = { user_id: userId, ...data, updated_at: nowIso() };
      this.guardian.cacheProfile(userId, payload);
      this.profileHotCache.set(userId, { data: payload, expiresAt: Date.now() + 5 * 60_000 });
      if (!this.zilliz.configured || this.zilliz.status === "dead" || this.sqliteOnly) {
        this.guardian.enqueue("zilliz", "update_profile", payload);
        return;
      }
      await this.writeZilliz("user_profiles", [{ id: String(userId), vector: await this.embed(JSON.stringify(payload)), payload }]).catch(err => {
        this.guardian.enqueue("zilliz", "update_profile", payload);
        logger.warn({ err, userId }, "Profile write queued after Zilliz failure");
      });
    });
  }

  async get_chat_history(chatId: number, days = 7): Promise<MemoryEntry[]> {
    return this.guardian.getDialogBuffer(chatId, days, 100);
  }

  async buildContext(userId: number, chatId: number, query: string): Promise<string> {
    const [memories, profile] = await Promise.all([this.recall(userId, chatId, query, 5), this.get_profile(userId)]);
    const parts: string[] = [];
    if (profile) parts.push(`[ГИБРИДНЫЙ ПРОФИЛЬ]\n${JSON.stringify(profile).slice(0, 900)}`);
    if (memories.length) parts.push(`[РЕЛЕВАНТНЫЙ КОНТЕКСТ]\n${memories.map(m => `• ${m.text}`).join("\n")}`);
    if (!this.qdrant.configured && !this.zilliz.configured) parts.push(`[СТАТУС ПАМЯТИ]\nВнешние векторные базы не настроены, активен SQLite Guardian fallback.`);
    return parts.length ? `\n\n${parts.join("\n")}` : "";
  }

  getStats(): Record<string, unknown> {
    return {
      guardian: this.guardian.getStats(),
      qdrant: this.qdrant.getMetrics(),
      zilliz: this.zilliz.getMetrics(),
      embeddingDimensions: EMBEDDING_DIM,
      pendingBatch: this.pending.length,
      economyMode: this.economyMode,
      sqliteOnly: this.sqliteOnly,
      zillizBlocked: this.zillizBlocked,
      sqliteBytes: this.guardian.getDbSizeBytes(),
      autoscaler: this.autoScaler.getLastState(),
      estimatedStorage: this.guardian.estimateExternalStorageMb(),
    };
  }

  private async embed(text: string): Promise<number[]> {
    if (!this.openai) return hashEmbedding(text, EMBEDDING_DIM);

    // ── Cache lookup (reduces OpenAI calls ~80% for repeated content) ─
    const cacheKey = text.trim().slice(0, 512); // cap key length
    const cached = this.guardian.getCachedEmbedding(cacheKey);
    if (cached && cached.length === EMBEDDING_DIM) return cached;

    try {
      const res = await this.openai.embeddings.create({ model: "text-embedding-3-small", input: text.slice(0, 8000) });
      const vector = normaliseVector(res.data[0]?.embedding ?? [], EMBEDDING_DIM);
      // Store in cache (non-blocking)
      this.guardian.setCachedEmbedding(cacheKey, vector);
      return vector;
    } catch (err) {
      logger.warn({ err }, "OpenAI embeddings failed, falling back to local hash embedding");
      return hashEmbedding(text, 384);
    }
  }

  private async flushBatch(): Promise<void> {
    const batch = this.pending.splice(0, 10);
    if (!batch.length) return;
    const byChat = new Map<number, Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>>();
    const archive: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
    for (const item of batch) {
      const payload = { user_id: item.entry.userId, chat_id: item.entry.chatId, text: item.entry.text, type: item.entry.type, timestamp: item.entry.timestamp };
      if (item.entry.type === "profile" || item.entry.type === "old_dialog" || item.entry.type === "event" || item.entry.type === "voice_transcript") {
        archive.push({ id: item.entry.id, vector: item.vector, payload });
      } else {
        const chatId = item.entry.chatId ?? 0;
        const list = byChat.get(chatId) ?? [];
        list.push({ id: item.entry.id, vector: item.vector, payload });
        byChat.set(chatId, list);
      }
    }
    for (const [chatId, points] of byChat) {
      if (!this.qdrant.configured || this.qdrant.status === "dead" || this.sqliteOnly) {
        for (const p of points) this.guardian.enqueue("qdrant", "upsert_dialog", { chatId, ...p });
      } else {
        await this.writeQdrant(`active_dialogs_${chatId}`, points).catch(err => {
          for (const p of points) this.guardian.enqueue("qdrant", "upsert_dialog", { chatId, ...p });
          logger.warn({ err, chatId }, "Qdrant write queued after failure");
        });
      }
    }
    if (archive.length) {
      if (!this.zilliz.configured || this.zilliz.status === "dead" || this.sqliteOnly) {
        for (const p of archive) this.guardian.enqueue("zilliz", "archive", p);
      } else {
        await this.writeZilliz("archive_data", archive).catch(err => {
          for (const p of archive) this.guardian.enqueue("zilliz", "archive", p);
          logger.warn({ err }, "Zilliz archive write queued after failure");
        });
      }
    }
  }

  private async syncQueued(): Promise<void> {
    for (const item of this.guardian.getQueued(25)) {
      try {
        if (item.target === "qdrant" && this.qdrant.configured && this.qdrant.status !== "dead") {
          const chatId = Number(item.payload["chatId"] ?? 0);
          await this.writeQdrant(`active_dialogs_${chatId}`, [item.payload as { id: string; vector: number[]; payload: Record<string, unknown> }]);
          this.guardian.markSynced(item.id);
        } else if (item.target === "zilliz" && this.zilliz.configured && this.zilliz.status !== "dead") {
          const collection = item.operation === "update_profile" ? "user_profiles" : "archive_data";
          const payload = item.operation === "update_profile" ? { id: String(item.payload["user_id"]), vector: await this.embed(JSON.stringify(item.payload)), payload: item.payload } : item.payload as { id: string; vector: number[]; payload: Record<string, unknown> };
          await this.writeZilliz(collection, [payload]);
          this.guardian.markSynced(item.id);
        }
      } catch (err) {
        this.guardian.markSyncFailed(item.id, err);
      }
    }
  }

  private async writeQdrant(collection: string, points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>): Promise<void> {
    await this.ensureQdrantCollection(collection);
    await this.qdrant.request("upsert", `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points: points.map(p => ({ id: p.id, vector: p.vector, payload: p.payload })) }),
    });
  }

  private async ensureQdrantCollection(collection: string): Promise<void> {
    await this.qdrant.request("ensure_collection", `/collections/${encodeURIComponent(collection)}`, {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    }).catch(err => {
      const msg = String(err);
      if (!msg.includes("already exists")) throw err;
    });
  }

  private async searchQdrant(collection: string, vector: number[], limit: number): Promise<MemoryEntry[]> {
    const res = await this.qdrant.request<{ result?: Array<{ id: string; score?: number; payload?: Record<string, unknown> }> }>("search", `/collections/${encodeURIComponent(collection)}/points/search`, {
      method: "POST",
      body: JSON.stringify({ vector, limit, with_payload: true }),
    });
    return (res.result ?? []).map(item => ({ id: String(item.id), text: String(item.payload?.["text"] ?? ""), type: String(item.payload?.["type"] ?? "dialog"), userId: item.payload?.["user_id"] === undefined ? undefined : Number(item.payload["user_id"]), chatId: item.payload?.["chat_id"] === undefined ? undefined : Number(item.payload["chat_id"]), timestamp: Number(item.payload?.["timestamp"] ?? Date.now()), score: item.score, metadata: item.payload })).filter(x => x.text);
  }

  private async writeZilliz(collection: string, points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>): Promise<void> {
    if (this.zillizBlocked) {
      // In emergency/critical state: only allow profile writes, block dialogs/archive
      const profileOnly = collection === "user_profiles";
      if (!profileOnly) {
        logger.warn({ collection, points: points.length }, "Zilliz write blocked by AutoScaler — queuing to SQLite");
        for (const p of points) this.guardian.enqueue("zilliz", "blocked_archive", p);
        return;
      }
    }
    await this.zilliz.request("insert", "/v2/vectordb/entities/insert", {
      method: "POST",
      body: JSON.stringify({ collectionName: collection, data: points.map(p => ({ id: p.id, vector: p.vector, ...p.payload })) }),
    });
  }

  private async searchZilliz(collection: string, vector: number[], limit: number, filter: Record<string, unknown> = {}): Promise<MemoryEntry[]> {
    const filterExpr = Object.entries(filter).map(([k, v]) => `${k} == ${typeof v === "number" ? v : `"${String(v).replace(/"/g, "\\\"")}"`}`).join(" and ");
    const res = await this.zilliz.request<{ data?: Array<Record<string, unknown>> }>("search", "/v2/vectordb/entities/search", {
      method: "POST",
      body: JSON.stringify({ collectionName: collection, data: [vector], limit, filter: filterExpr || undefined, outputFields: ["id", "user_id", "chat_id", "text", "type", "timestamp"] }),
    });
    return (res.data ?? []).map(item => ({ id: String(item["id"] ?? randomUUID()), text: String(item["text"] ?? ""), type: String(item["type"] ?? "archive"), userId: item["user_id"] === undefined ? undefined : Number(item["user_id"]), chatId: item["chat_id"] === undefined ? undefined : Number(item["chat_id"]), timestamp: Number(item["timestamp"] ?? Date.now()), score: Number(item["distance"] ?? item["score"] ?? 0), metadata: item })).filter(x => x.text || x.metadata);
  }

  private async migrateColdData(): Promise<void> {
    const candidates = this.guardian.getDialogBuffer(0, 3650, 0);
    void candidates;
    logger.debug({ hotDays: HOT_DAYS }, "Hybrid memory cold migration tick");
  }

  private async autoscale(): Promise<void> {
    const sqliteMb = this.guardian.getDbSizeBytes() / 1024 / 1024;
    const qdrantQuotaMb = Number(process.env["QDRANT_QUOTA_MB"] ?? 1000);
    const zillizQuotaMb = Number(process.env["ZILLIZ_QUOTA_MB"] ?? 5000);
    const { qdrantMb, zillizMb } = this.guardian.estimateExternalStorageMb();
    const qdrantLatencyMs = this.qdrant.getMetrics().latencyMs;
    const zillizLatencyMs = this.zilliz.getMetrics().latencyMs;

    const state = this.autoScaler.evaluate(
      { qdrantMb, qdrantQuotaMb, zillizMb, zillizQuotaMb, sqliteMb, qdrantLatencyMs, zillizLatencyMs },
      {
        setEconomyMode: (on) => { this.economyMode = on; },
        setSqliteOnly: (on) => { this.sqliteOnly = on; },
        setZillizBlocked: (on) => { this.zillizBlocked = on; },
        alertAdmin: (msg) => { this.alertCallback?.(msg); },
        log: (level, message, meta) => { this.guardian.log(level, message, meta ?? {}); },
      },
    );

    this.guardian.setState("autoscaler", state);
    logger.debug({ state }, "AutoScaler evaluated");
  }
}

export const hybridMemory = new HybridMemory();
