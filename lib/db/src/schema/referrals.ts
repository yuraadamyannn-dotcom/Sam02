import { pgTable, bigint, text, integer, timestamp, serial, index } from "drizzle-orm/pg-core";

// Tracks personalized invite links created by users
export const inviteLinksTable = pgTable("invite_links", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  creatorId: bigint("creator_id", { mode: "number" }).notNull(),
  inviteLink: text("invite_link").notNull(),
  name: text("name"),
  usesCount: integer("uses_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tracks who invited whom via deep link referrals
export const referralsTable = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerId: bigint("referrer_id", { mode: "number" }).notNull(),
  newUserId: bigint("new_user_id", { mode: "number" }).notNull(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ref_referrer_idx").on(table.referrerId),
  index("ref_new_user_idx").on(table.newUserId),
]);
