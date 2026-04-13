// In-memory flood + spam detection

interface UserFloodState {
  timestamps: number[];
  warnCount: number;
  lastWarnAt: number;
}

const floodMap = new Map<string, UserFloodState>();

export function checkFlood(
  chatId: number,
  userId: number,
  config: { threshold: number; windowMs: number }
): { isFlood: boolean; count: number } {
  const key = `${chatId}:${userId}`;
  const now = Date.now();
  const state = floodMap.get(key) ?? { timestamps: [], warnCount: 0, lastWarnAt: 0 };

  // Remove old timestamps
  state.timestamps = state.timestamps.filter(t => now - t < config.windowMs);
  state.timestamps.push(now);
  floodMap.set(key, state);

  const count = state.timestamps.length;
  return { isFlood: count >= config.threshold, count };
}

export function resetFlood(chatId: number, userId: number): void {
  floodMap.delete(`${chatId}:${userId}`);
}

// Spam word filter
const SPAM_PATTERNS = [
  /t\.me\/[a-zA-Z0-9_]{4,}/i,   // Telegram links
  /https?:\/\/(?!youtu\.be|youtube\.com|open\.spotify)[^\s]+/i, // External URLs
  /(?:заработок|заработай|крипто|инвест|казино|ставки|вывод\s+\d)/i, // Финансовый спам
  /(?:подпишись|подписывайся|переходи|вступай|добавляйся)/i, // Промо
];

export function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some(p => p.test(text));
}

// Threat / abuse detection
const ABUSE_WORDS = new Set([
  "убью","убьет","прибью","задушу","сломаю","зарежу","пристрелю",
  "скам","скамер","мошенник","кидала",
]);

export function isAbusive(text: string): boolean {
  const lower = text.toLowerCase();
  return Array.from(ABUSE_WORDS).some(w => lower.includes(w));
}
