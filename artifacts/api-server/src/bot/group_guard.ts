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

export function incrementRate(chatId: number): void {
  getRate(chatId).count++;
}

// ─── Direct conversation tracker ─────────────────────────────────────────────
// When a user is actively talking TO the bot, rate limit is lifted for that user.

const DIRECT_TIMEOUT_MS = 3 * 60 * 1000; // 3 min idle → conversation over

interface DirectConvo { userId: number; lastActive: number; }
const directConvos = new Map<number, DirectConvo>();

export function isDirectConvo(chatId: number, userId: number): boolean {
  const dc = directConvos.get(chatId);
  if (!dc || dc.userId !== userId) return false;
  if (Date.now() - dc.lastActive > DIRECT_TIMEOUT_MS) {
    directConvos.delete(chatId);
    return false;
  }
  return true;
}

export function touchDirectConvo(chatId: number, userId: number): void {
  directConvos.set(chatId, { userId, lastActive: Date.now() });
}

export function clearDirectConvo(chatId: number): void {
  directConvos.delete(chatId);
}

// ─── Two-person dialogue detector ─────────────────────────────────────────────
// If the last N messages in the chat are exclusively between 2 users (no bot),
// we don't interrupt.

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

// ─── Main decision: should the bot reply to this group message? ───────────────

export type ReplyReason =
  | "reply_to_bot"
  | "direct_mention"
  | "direct_convo"
  | "question"
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

  // Name-based address: "сэм, ..." / "sam, ..." / "эй сэм" / standalone "сэм"
  const nameParts = ["сэм", "sam"];
  const mentionedByName = nameParts.some(n => {
    // Word boundary check: surrounded by spaces, punctuation or start/end of string
    const re = new RegExp(`(^|[\\s,!?])${n}([\\s,!?]|$)`, "i");
    return re.test(lower);
  });

  if (mentionedByEntity || mentionedByName) return "direct_mention";

  // ── 3. Ongoing direct conversation (user was talking to bot recently) ──────
  if (isDirectConvo(chatId, userId)) return "direct_convo";

  // ── 4. Two-person dialogue — stay quiet ──────────────────────────────────
  if (isTwoPersonDialogue(chatId, botId)) return "skip";

  // ── 5. Question not directed at a specific other user ─────────────────────
  const hasQuestion = text.includes("?");
  const directedAtOther =
    (msg.entities?.some(e => e.type === "mention" || e.type === "text_mention") ?? false) &&
    !mentionedByEntity;

  if (hasQuestion && !directedAtOther) return "question";

  // ── 6. Anything else → silence ────────────────────────────────────────────
  return "skip";
}
