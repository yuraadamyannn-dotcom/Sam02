import { pgTable, serial, bigint, integer, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const userAnalyticsTable = pgTable("user_analytics", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageCount: integer("message_count").notNull().default(0),
  voiceCount: integer("voice_count").notNull().default(0),
  stickerCount: integer("sticker_count").notNull().default(0),
  avgSentiment: real("avg_sentiment").default(0),
  topicsJson: text("topics_json"),
  lastActive: timestamp("last_active", { withTimezone: true }).notNull().defaultNow(),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
  warningCount: integer("warning_count").notNull().default(0),
  muteCount: integer("mute_count").notNull().default(0),
}, (table) => [
  uniqueIndex("ua_user_chat_idx").on(table.userId, table.chatId),
]);

export type UserAnalytics = typeof userAnalyticsTable.$inferSelect;
