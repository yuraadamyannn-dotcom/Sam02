import { pgTable, serial, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const groupWarningsTable = pgTable("group_warnings", {
  id: serial("id").primaryKey(),
  groupId: bigint("group_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  reason: text("reason"),
  issuedBy: bigint("issued_by", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GroupWarning = typeof groupWarningsTable.$inferSelect;
