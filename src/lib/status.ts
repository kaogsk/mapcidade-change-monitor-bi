// Status grouping used by every alert visual (the "grouped status" calculated column of the
// dashboard this BI replaced). Statuses outside the lists keep their own name: some cities
// created local statuses, and folding them into "Other" made totals impossible to reconcile
// with what the city sees.

export const IN_ANALYSIS = [
  "Fiscal action",
  "Forwarded",
  "Forwarded for alert analysis",
  "Field return",
  "Inspection",
] as const;

export const FINISHED = [
  "Finished - process opened",
  "Finished - fined after monitoring",
  "Finished - previously fined",
  "Finished - via system",
  "Finished via analysis",
  "Finished via integration",
  "Finished via notification",
  "Existing process",
  "Expired",
] as const;

export const PENDING = "Pending";
export const GROUPS = ["Pending", "In analysis", "Finished"] as const;

export function statusGroup(s: string | null | undefined): string | null {
  if (s == null) return null;
  if (s === PENDING) return "Pending";
  if ((IN_ANALYSIS as readonly string[]).includes(s)) return "In analysis";
  if ((FINISHED as readonly string[]).includes(s)) return "Finished";
  return s;
}
