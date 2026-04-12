import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const botStickersTable = pgTable("bot_stickers", {
  id: serial("id").primaryKey(),
  fileId: text("file_id").notNull().unique(),
  setName: text("set_name"),
  emoji: text("emoji"),
  category: text("category").default("general"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BotSticker = typeof botStickersTable.$inferSelect;
