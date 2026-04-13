import { pgTable, serial, bigint, text, real, timestamp } from "drizzle-orm/pg-core";

export const messageLogTable = pgTable("message_log", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  username: text("username"),
  text: text("text").notNull(),
  sentiment: real("sentiment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageLog = typeof messageLogTable.$inferSelect;
