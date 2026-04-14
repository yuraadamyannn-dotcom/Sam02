import TelegramBot from "node-telegram-bot-api";

// ─── Rate limiter: max 3-7 bot messages per 10 minutes per chat ───────────────

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MIN = 3;
const RATE_MAX = 7;

interface RateState { count: number; cap: number; windowStart: number; }
const chatRates = new Map<number, RateState>();

function getRate(chatId: number): RateState {
  const now = Date.now();
  let s = chatRates.get(chatId);
  if (!s || now - s.windowStart > RATE_WINDOW_MS) {
    s = {
      count: 0,
      cap: RATE_MIN + Math.floor(Math.random() * (RATE_MAX - RATE_MIN + 1)),
      windowStart: now,
    };
    chatRates.set(chatId, s);
  }
  return s;
}

export function rateLimitAllowed(chatId: number): boolean {
  const s = getRate(chatId);
  return s.count < s.cap;
}

// Only counts messages that are NOT rate-limit-exempt (i.e. regular questions/requests)
export function incrementRate(chatId: number): void {
  getRate(chatId).count++;
}

// ─── Direct conversation tracker ─────────────────────────────────────────────
// Supports multiple concurrent direct convos per chat.
// Rate limit is lifted per user while they are actively talking to the bot.

const DIRECT_TIMEOUT_MS = 3 * 60 * 1000; // 3 min idle → conversation ends

// Map<chatId, Map<userId, lastActive>>
const directConvos = new Map<number, Map<number, number>>();

export function isDirectConvo(chatId: number, userId: number): boolean {
  const chatMap = directConvos.get(chatId);
  if (!chatMap) return false;
  const lastActive = chatMap.get(userId);
  if (lastActive === undefined) return false;
  if (Date.now() - lastActive > DIRECT_TIMEOUT_MS) {
    chatMap.delete(userId);
    return false;
  }
  return true;
}

export function touchDirectConvo(chatId: number, userId: number): void {
  let chatMap = directConvos.get(chatId);
  if (!chatMap) {
    chatMap = new Map();
    directConvos.set(chatId, chatMap);
  }
  chatMap.set(userId, Date.now());
}

// Pass userId to clear a specific user, or omit to clear all for the chat
export function clearDirectConvo(chatId: number, userId?: number): void {
  if (userId !== undefined) {
    directConvos.get(chatId)?.delete(userId);
  } else {
    directConvos.delete(chatId);
  }
}

// ─── New member tracker ───────────────────────────────────────────────────────
// New members get bot attention for 10 minutes after joining so Sam
// can help them settle in and support the conversation.

const NEW_MEMBER_WINDOW_MS = 10 * 60 * 1000;

// Map<chatId, Map<userId, joinedAt>>
const newMemberMap = new Map<number, Map<number, number>>();

export function markNewMember(chatId: number, userId: number): void {
  let chatMap = newMemberMap.get(chatId);
  if (!chatMap) {
    chatMap = new Map();
    newMemberMap.set(chatId, chatMap);
  }
  chatMap.set(userId, Date.now());
}

export function isNewMember(chatId: number, userId: number): boolean {
  const chatMap = newMemberMap.get(chatId);
  if (!chatMap) return false;
  const joinedAt = chatMap.get(userId);
  if (joinedAt === undefined) return false;
  if (Date.now() - joinedAt > NEW_MEMBER_WINDOW_MS) {
    chatMap.delete(userId);
    return false;
  }
  return true;
}

// ─── Bot activity tracker (for proactive chat revival) ────────────────────────
// Tracks when the bot last sent a message in each chat.
// Also tracks when the chat last had any activity (human messages).

const lastBotMsg = new Map<number, number>();     // chatId → timestamp
const lastChatActivity = new Map<number, number>(); // chatId → timestamp

export function recordBotActivity(chatId: number): void {
  lastBotMsg.set(chatId, Date.now());
}

export function recordChatActivity(chatId: number): void {
  lastChatActivity.set(chatId, Date.now());
}

/**
 * Returns chat IDs where:
 * - the bot hasn't spoken for at least `botSilentMs` ms
 * - the chat has had human activity within `activityWindowMs` ms (so it's not dead)
 */
export function getQuietChats(
  allChatIds: number[],
  botSilentMs = 30 * 60 * 1000,
  activityWindowMs = 60 * 60 * 1000,
): number[] {
  const now = Date.now();
  return allChatIds.filter(id => {
    const botLast = lastBotMsg.get(id) ?? 0;
    const chatLast = lastChatActivity.get(id) ?? 0;
    const botWasSilent = (now - botLast) >= botSilentMs;
    const chatWasActive = (now - chatLast) < activityWindowMs;
    return botWasSilent && chatWasActive;
  });
}

// ─── Two-person dialogue detector ─────────────────────────────────────────────
// If the last N messages in the chat are exclusively between 2 users (no bot),
// don't interrupt.

interface ChatMsg { userId: number; ts: number; }
const recentMsgs = new Map<number, ChatMsg[]>();

export function recordMsg(chatId: number, userId: number): void {
  const hist = recentMsgs.get(chatId) ?? [];
  hist.push({ userId, ts: Date.now() });
  if (hist.length > 20) hist.splice(0, hist.length - 20);
  recentMsgs.set(chatId, hist);
}

function isTwoPersonDialogue(chatId: number, botId: number): boolean {
  const hist = recentMsgs.get(chatId) ?? [];
  const recent = hist.slice(-8);
  if (recent.length < 4) return false;
  const uniqueUsers = new Set(recent.map(m => m.userId).filter(id => id !== botId));
  if (uniqueUsers.size !== 2) return false;
  // All recent messages must be from humans only (bot hasn't spoken)
  return recent.every(m => m.userId !== botId);
}

// ─── Request detection ────────────────────────────────────────────────────────
// Detects imperative verbs that constitute a request not directed at another user.

const REQUEST_RE = /^(расскажи|объясни|помоги|покажи|найди|скинь|кинь|принеси|пришли|напиши|напомни|посчитай|переведи|сделай|проверь|посмотри|подскажи|скажи|ответь|дай|дайте|спой|включи|поставь|поищи|порекомендуй|посоветуй|придумай|сочини|нарисуй|генерируй)\b/i;

function isRequest(text: string, msg: TelegramBot.Message): boolean {
  // Don't fire if message is clearly directed at another specific user
  const directedAtOther =
    msg.entities?.some(e => e.type === "mention" || e.type === "text_mention") ?? false;
  if (directedAtOther) return false;
  return REQUEST_RE.test(text.trim());
}

// ─── Main decision: should the bot reply to this group message? ───────────────

export type ReplyReason =
  | "reply_to_bot"
  | "direct_mention"
  | "direct_convo"
  | "new_member"
  | "question"
  | "request"
  | "skip";

export function shouldGroupReply(
  msg: TelegramBot.Message,
  botId: number,
  botUsername: string,
): ReplyReason {
  const text = (msg.text ?? "").trim();
  const lower = text.toLowerCase();
  const userId = msg.from?.id ?? 0;
  const chatId = msg.chat.id;
  const botUserLower = botUsername.replace(/^@/, "").toLowerCase();

  // ── 1. Reply to bot's own message → always respond ────────────────────────
  if (msg.reply_to_message?.from?.id === botId) return "reply_to_bot";

  // ── 2. Direct @mention of bot ─────────────────────────────────────────────
  const mentionedByEntity = msg.entities?.some(e =>
    e.type === "mention" &&
    text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUserLower}`
  ) ?? false;

  // Name-based address: "сэм, ..." / "sam, ..." / "эй сэм" etc.
  const nameParts = ["сэм", "sam"];
  const mentionedByName = nameParts.some(n => {
    const re = new RegExp(`(^|[\\s,!?])${n}([\\s,!?]|$)`, "i");
    return re.test(lower);
  });

  if (mentionedByEntity || mentionedByName) return "direct_mention";

  // ── 3. Ongoing direct conversation (user was recently talking to bot) ──────
  if (isDirectConvo(chatId, userId)) return "direct_convo";

  // ── 4. New member period — bot stays attentive to help them integrate ──────
  if (isNewMember(chatId, userId)) return "new_member";

  // ── 5. Two-person dialogue between humans — stay quiet ────────────────────
  if (isTwoPersonDialogue(chatId, botId)) return "skip";

  // ── 6. Question not directed at a specific other user ─────────────────────
  const hasQuestion = text.includes("?");
  const directedAtOther =
    (msg.entities?.some(e => e.type === "mention" || e.type === "text_mention") ?? false) &&
    !mentionedByEntity;

  if (hasQuestion && !directedAtOther) return "question";

  // ── 7. Imperative request (not directed at another user) ──────────────────
  if (isRequest(text, msg)) return "request";

  // ── 8. Anything else → silence ────────────────────────────────────────────
  return "skip";
}
