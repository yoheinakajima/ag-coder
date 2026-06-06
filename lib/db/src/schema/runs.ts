import { pgTable, text, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const runsTable = pgTable("runs", {
  id: text("id").primaryKey(),
  goal: text("goal").notNull(),
  // Lifecycle: pending | running | awaiting_approval | completed | failed | cancelled | rejected
  status: text("status").notNull().default("pending"),
  parentRunId: text("parent_run_id"),
  forkEventId: text("fork_event_id"),
  model: text("model"),
  workDir: text("work_dir"),
  repoUrl: text("repo_url"),
  repoBranch: text("repo_branch"),
  prUrl: text("pr_url"),
  prStatus: text("pr_status"),
  // When true, the agent pauses at awaiting_approval after producing changes; a
  // human must approve before they are committed (ActiveGraph approval flow).
  requireApproval: boolean("require_approval").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

// Human-in-the-loop approvals. Each row mirrors an ActiveGraph approval
// (approval.requested -> approval.granted/denied) surfaced for the UI.
export const agentApprovalsTable = pgTable("agent_approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runsTable.id),
  kind: text("kind").notNull(), // e.g. "patch_set"
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  summary: text("summary"),
  data: jsonb("data"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
});

export const agentEventsTable = pgTable("agent_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runsTable.id),
  type: text("type").notNull(),
  seq: integer("seq").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const graphObjectsTable = pgTable("graph_objects", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  objectType: text("object_type").notNull(),
  data: jsonb("data"),
});

export const graphRelationsTable = pgTable("graph_relations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  source: text("source").notNull(),
  target: text("target").notNull(),
  relationType: text("relation_type").notNull(),
});

export const insertRunSchema = createInsertSchema(runsTable);
export type InsertRun = z.infer<typeof insertRunSchema>;
export type Run = typeof runsTable.$inferSelect;
export type AgentEvent = typeof agentEventsTable.$inferSelect;
export type GraphObject = typeof graphObjectsTable.$inferSelect;
export type GraphRelation = typeof graphRelationsTable.$inferSelect;
export type AgentApproval = typeof agentApprovalsTable.$inferSelect;
