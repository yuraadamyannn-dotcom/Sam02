// Simple Russian + English sentiment analysis (no external dependency)

const POSITIVE_RU = new Set([
  "хорошо","отлично","круто","классно","супер","здорово","молодец","умница",
  "нравится","люблю","обожаю","кайф","огонь","топ","шикарно","прекрасно",
  "рад","счастлив","спасибо","благодарю","лучший","лучшая","удачно","успех",
  "ха","хаха","лол","смешно","весело","прикольно","интересно","красиво",
  "правда","согласен","согласна","поддерживаю","ок","окей","да","точно",
  "сочувствую","понимаю","держись","поддержу",
]);

const NEGATIVE_RU = new Set([
  "плохо","ужасно","отстой","кринж","фу","фуфло","мусор","провал","неудача",
  "ненавижу","бесит","раздражает","достал","достала","надоел","надоела",
  "дурак","идиот","тупой","тупая","балбес","дура","урод","ублюдок","мразь",
  "скотина","тварь","заткнись","пошел","пошла","отвали","отстань","вали",
  "враг","ненависть","злость","агрессия","угрожаю","убью","прибью",
  "плачу","грустно","тяжело","больно","страдаю","страдать","одиноко","одинок",
  "нет","неправда","неверно","ложь","обманываешь","соврал",
]);

const ESCALATION_MARKERS = new Set([
  "заткнись","пошел","пошла","отвали","убью","прибью","дам","ударю",
  "урод","ублюдок","мразь","скотина","тварь","свинья","животное",
]);

const PEACE_MARKERS = new Set([
  "хватит","успокойтесь","не ссорьтесь","помиритесь","стоп","прекратите",
  "ладно","мир","ок","всё","хорошо","пожалуйста",
]);

export function analyzeSentiment(text: string): number {
  const words = text.toLowerCase().replace(/[.,!?;:]/g, "").split(/\s+/);
  let score = 0;
  let count = 0;

  for (const word of words) {
    if (POSITIVE_RU.has(word)) { score += 1; count++; }
    else if (ESCALATION_MARKERS.has(word)) { score -= 2; count++; }
    else if (NEGATIVE_RU.has(word)) { score -= 1; count++; }
  }

  if (count === 0) return 0;
  return Math.max(-1, Math.min(1, score / count));
}

export function isEscalation(text: string): boolean {
  const lower = text.toLowerCase();
  return Array.from(ESCALATION_MARKERS).some(m => lower.includes(m));
}

export function isPeaceSignal(text: string): boolean {
  const lower = text.toLowerCase();
  return Array.from(PEACE_MARKERS).some(m => lower.includes(m));
}

export function detectConflictContext(
  messages: { userId: number; text: string; sentiment: number }[]
): { isConflict: boolean; aggressorId?: number; reason: string } {
  if (messages.length < 3) return { isConflict: false, reason: "not enough context" };

  const recent = messages.slice(-10);
  const avgSentiment = recent.reduce((s, m) => s + m.sentiment, 0) / recent.length;

  // Check if sentiment dropped sharply
  if (avgSentiment < -0.6) {
    // Find who has the most negative messages
    const userScores = new Map<number, { total: number; count: number }>();
    for (const m of recent) {
      const cur = userScores.get(m.userId) ?? { total: 0, count: 0 };
      userScores.set(m.userId, { total: cur.total + m.sentiment, count: cur.count + 1 });
    }

    let aggressorId: number | undefined;
    let worstScore = -0.3;
    for (const [uid, stats] of userScores.entries()) {
      const avg = stats.total / stats.count;
      if (avg < worstScore) { worstScore = avg; aggressorId = uid; }
    }

    // Check for peace signals — if chat is calming down, don't punish
    const hasPeace = recent.some(m => isPeaceSignal(m.text));
    if (hasPeace) return { isConflict: false, reason: "peace signal detected" };

    return { isConflict: true, aggressorId, reason: `avg sentiment ${avgSentiment.toFixed(2)}` };
  }

  return { isConflict: false, reason: "normal" };
}
