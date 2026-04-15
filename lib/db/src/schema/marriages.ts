import { pgTable, serial, bigint, timestamp, index } from "drizzle-orm/pg-core";

export const marriagesTable = pgTable("marriages", {
  id: serial("id").primaryKey(),
  user1Id: bigint("user1_id", { mode: "number" }).notNull(),
  user2Id: bigint("user2_id", { mode: "number" }).notNull(),
  groupId: bigint("group_id", { mode: "number" }),
  marriedAt: timestamp("married_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("marr_user1_idx").on(table.user1Id),
  index("marr_user2_idx").on(table.user2Id),
]);

export type Marriage = typeof marriagesTable.$inferSelect;
