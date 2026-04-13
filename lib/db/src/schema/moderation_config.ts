import { pgTable, bigint, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export const moderationConfigTable = pgTable("moderation_config", {
  groupId: bigint("group_id", { mode: "number" }).primaryKey(),
  antispamEnabled: boolean("antispam_enabled").notNull().default(true),
  autobanEnabled: boolean("autoban_enabled").notNull().default(false),
  conflictSensitivity: text("conflict_sensitivity").notNull().default("medium"),
  moderationEnabled: boolean("moderation_enabled").notNull().default(true),
  floodThreshold: integer("flood_threshold").notNull().default(5),
  customRulesJson: text("custom_rules_json"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ModerationConfig = typeof moderationConfigTable.$inferSelect;
