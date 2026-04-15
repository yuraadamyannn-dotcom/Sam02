import { pgTable, bigint, integer, timestamp } from "drizzle-orm/pg-core";

export const botProcessedCommandsTable = pgTable("bot_processed_commands", {
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  messageId: integer("message_id").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
