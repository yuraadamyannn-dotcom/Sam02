import { pgTable, serial, bigint, real, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const userProfilesTable = pgTable("user_profiles", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),

  // Personality axes (−1 to +1 or 0 to 1)
  introvertScore: real("introvert_score").default(0),       // -1 extrovert ↔ +1 introvert
  sociaphobeScore: real("sociaphobe_score").default(0),     // 0 normal ↔ 1 max sociaphobe
  aggressionScore: real("aggression_score").default(0),     // 0 calm ↔ 1 aggressive
  friendlinessScore: real("friendliness_score").default(0.5), // 0 cold ↔ 1 very warm
  sarcasticScore: real("sarcastic_score").default(0),       // 0 sincere ↔ 1 very sarcastic
  activityLevel: real("activity_level").default(0.5),       // 0 lurker ↔ 1 very active

  // Counters
  conflictCount: integer("conflict_count").notNull().default(0),
  muteCount: integer("mute_count").notNull().default(0),
  warnCount: integer("warn_count").notNull().default(0),
  apologyCount: integer("apology_count").notNull().default(0),
  humorCount: integer("humor_count").notNull().default(0),
  questionCount: integer("question_count").notNull().default(0),
  messagesAnalyzed: integer("messages_analyzed").notNull().default(0),

  // Qualitative
  communicationStyle: text("communication_style").default("neutral"), // friendly/aggressive/passive/sarcastic/shy/leader/lurker
  dominantTopics: text("dominant_topics"), // JSON array of topic strings
  notableTraits: text("notable_traits"), // JSON array
  psychSummary: text("psych_summary"), // generated dossier text (Groq)
  rawNotes: text("raw_notes"), // freeform observations

  lastAnalyzed: timestamp("last_analyzed", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("up_user_chat_idx").on(table.userId, table.chatId),
]);

export type UserProfile = typeof userProfilesTable.$inferSelect;
