/**
 * ─── Хранилище callback payload ───────────────────────────────────────────────
 *
 * Telegram лимитирует callback_data до 64 БАЙТ.
 * Для хранения длинных данных (текст голосового, запрос текста песни)
 * генерируем короткий 8-символьный ключ и сохраняем payload в памяти.
 *
 * TTL: 2 часа — потом ключ удаляется автоматически (кнопки устаревают).
 */

const TTL_MS = 2 * 60 * 60 * 1000; // 2 часа

interface Entry {
  payload: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

// Чистка устаревших записей каждые 30 минут
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt < now) store.delete(k);
  }
}, 30 * 60 * 1000).unref?.();

function randomKey(): string {
  return Math.random().toString(36).slice(2, 10); // 8 chars
}

/**
 * Сохранить payload и вернуть короткий ключ.
 * Prefix + ":" + key = callback_data (≤ 20 байт — хорошо вписывается в лимит).
 */
export function storePayload(prefix: string, payload: string): string {
  const key = randomKey();
  store.set(`${prefix}:${key}`, { payload, expiresAt: Date.now() + TTL_MS });
  return `${prefix}:${key}`;
}

/**
 * Получить payload по полному callback_data (prefix:key).
 * Возвращает null если ключ не найден или устарел.
 */
export function getPayload(callbackData: string): string | null {
  const entry = store.get(callbackData);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(callbackData);
    return null;
  }
  return entry.payload;
}

/** Проверка: относится ли callback_data к данному prefix */
export function hasPrefix(callbackData: string, prefix: string): boolean {
  return callbackData.startsWith(`${prefix}:`);
}
