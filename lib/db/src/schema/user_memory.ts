import { pgTable, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const userMemoryTable = pgTable("user_memory", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  name: text("name"),
  summary: text("summary"),
  interests: text("interests"),
  notes: text("notes"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
});

export type UserMemory = typeof userMemoryTable.$inferSelect;
