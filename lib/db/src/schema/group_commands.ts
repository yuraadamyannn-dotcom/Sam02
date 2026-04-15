import { pgTable, serial, bigint, text, timestamp, index } from "drizzle-orm/pg-core";

export const groupCommandsTable = pgTable("group_commands", {
  id: serial("id").primaryKey(),
  groupId: bigint("group_id", { mode: "number" }).notNull(),
  trigger: text("trigger").notNull(),
  response: text("response").notNull(),
  responseType: text("response_type").notNull().default("text"),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("gc_group_idx").on(table.groupId),
]);

export type GroupCommand = typeof groupCommandsTable.$inferSelect;
