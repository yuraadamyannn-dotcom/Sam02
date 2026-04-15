import { pgTable, serial, bigint, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const chatEventsTable = pgTable("chat_events", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  eventType: text("event_type").notNull(), // rule_change | member_add | member_remove | conflict | admin_dispute | mood_shift | ban | mute | warn | mafia | marriage | broadcast
  description: text("description").notNull(),
  participantsJson: text("participants_json"), // JSON: [{id, name}]
  severity: integer("severity").notNull().default(1), // 1-10
  resolved: boolean("resolved").notNull().default(false),
  context: text("context"), // what led to this
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ce_chat_ts_idx").on(table.chatId, table.recordedAt),
  index("ce_chat_type_idx").on(table.chatId, table.eventType),
]);

export type ChatEvent = typeof chatEventsTable.$inferSelect;
