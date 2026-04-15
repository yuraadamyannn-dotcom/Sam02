import { pgTable, serial, bigint, text, real, timestamp, index } from "drizzle-orm/pg-core";

export const messageLogTable = pgTable("message_log", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  username: text("username"),
  text: text("text").notNull(),
  sentiment: real("sentiment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ml_chat_ts_idx").on(table.chatId, table.createdAt),
  index("ml_user_idx").on(table.userId),
]);

export type MessageLog = typeof messageLogTable.$inferSelect;
