import { pgTable, serial, bigint, text, timestamp, index } from "drizzle-orm/pg-core";

export const scheduledMessagesTable = pgTable("scheduled_messages", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sm_user_status_idx").on(table.userId, table.status),
  index("sm_scheduled_status_idx").on(table.scheduledAt, table.status),
]);

export type ScheduledMessage = typeof scheduledMessagesTable.$inferSelect;
