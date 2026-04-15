import { pgTable, bigint, text, integer, timestamp, index } from "drizzle-orm/pg-core";

export const botChatsTable = pgTable("bot_chats", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  title: text("title"),
  type: text("type").notNull().default("private"),
  memberCount: integer("member_count"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  topicSummary: text("topic_summary"),
}, (table) => [
  index("bc_last_active_idx").on(table.lastActiveAt),
  index("bc_type_idx").on(table.type),
]);

export type BotChat = typeof botChatsTable.$inferSelect;
