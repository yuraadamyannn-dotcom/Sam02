import { pgTable, serial, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const groupCommandsTable = pgTable("group_commands", {
  id: serial("id").primaryKey(),
  groupId: bigint("group_id", { mode: "number" }).notNull(),
  trigger: text("trigger").notNull(),
  response: text("response").notNull(),
  responseType: text("response_type").notNull().default("text"),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GroupCommand = typeof groupCommandsTable.$inferSelect;
