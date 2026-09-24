/**
 * Pure plan parsing (docs/07 §2 step 7; docs/04 §4 — model output is untrusted).
 *
 * The model MAY publish a structured plan in a fenced ```redai:plan``` block. The plan
 * is untrusted: it is parsed ONCE and validated to an exact shape; a present-but-
 * malformed plan is REJECTED (never coerced), and its absence is fine (an empty plan).
 * The plan is context/UX state only — it grants no authority and dispatches nothing.
 */

export type PlanItemStatus = 'pending' | 'active' | 'done' | 'blocked';

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
}

export type ParsePlanResult = { ok: true; plan: PlanItem[] } | { ok: false; reason: string };

const STATUSES: readonly PlanItemStatus[] = ['pending', 'active', 'done', 'blocked'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Locate a fenced ```redai:plan``` block in the assistant text. Returns the raw JSON
 * text when present. Only the FIRST block is honored; nothing else in the prose is
 * interpreted as a plan.
 */
export function extractPlanBlock(text: string): { present: boolean; raw: string } {
  const fence = /```redai:plan\s*([\s\S]*?)```/m.exec(text);
  if (!fence || fence[1] === undefined) return { present: false, raw: '' };
  return { present: true, raw: fence[1].trim() };
}

/** Validate an already-parsed candidate value into a {@link PlanItem}[]. */
function validatePlanValue(value: unknown): ParsePlanResult {
  const items = isRecord(value) ? value['plan'] : value;
  if (items === undefined || items === null) return { ok: true, plan: [] };
  if (!Array.isArray(items)) return { ok: false, reason: 'plan is not an array' };
  const plan: PlanItem[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isRecord(item)) return { ok: false, reason: `plan[${i}] is not an object` };
    const id = item['id'];
    const title = item['title'];
    const status = item['status'];
    if (typeof id !== 'string' || id === '') return { ok: false, reason: `plan[${i}].id` };
    if (typeof title !== 'string' || title === '') {
      return { ok: false, reason: `plan[${i}].title` };
    }
    if (typeof status !== 'string' || !STATUSES.includes(status as PlanItemStatus)) {
      return { ok: false, reason: `plan[${i}].status` };
    }
    plan.push({ id, title, status: status as PlanItemStatus });
  }
  return { ok: true, plan };
}

/**
 * Parse the plan out of assistant text. Absent → empty plan (ok). Present but not
 * parseable JSON, or not the exact shape → rejected (the runtime treats this as a
 * MODEL_OUTPUT_INVALID and dispatches nothing).
 */
export function parsePlanFromText(text: string): ParsePlanResult {
  const block = extractPlanBlock(text);
  if (!block.present) return { ok: true, plan: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.raw);
  } catch {
    return { ok: false, reason: 'plan block is not valid JSON' };
  }
  return validatePlanValue(parsed);
}
