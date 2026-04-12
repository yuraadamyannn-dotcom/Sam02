import { pgTable, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const groupSettingsTable = pgTable("group_settings", {
  groupId: bigint("group_id", { mode: "number" }).primaryKey(),
  rules: text("rules"),
  welcomeMsg: text("welcome_msg"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GroupSettings = typeof groupSettingsTable.$inferSelect;
