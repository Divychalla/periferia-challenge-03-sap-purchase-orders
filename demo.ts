import path from "node:path";
import { resetOutput, runTool, type ToolName } from "./src/tools/po.js";
import type { ToolCallResult } from "./src/tools/po.js";

const directory = process.cwd();
const context = { directory, sessionId: "demo" };
await resetOutput(context);

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };
type Validation = { eligible: boolean; blockers: Array<{ code: string; detail: string }>; confirmations: Array<{ code: string; detail: string }>; retroactive: boolean };

async function call<T>(name: ToolName, args: unknown): Promise<Envelope<T>> {
  const result: ToolCallResult = await runTool(name, args, context);
  return result.result as Envelope<T>;
}

for (let index = 1; index <= 6; index += 1) {
  const caseId = `req-00${index}`;
  const read = await call<unknown>("po_read_package", { case_id: caseId });
  if (!read.ok) {
    console.log(`${caseId}: package unavailable — ${read.error}`);
    continue;
  }
  const validated = await call<Validation>("po_validate", { case_id: caseId, package: read.data });
  if (!validated.ok) {
    console.log(`${caseId}: validation failed — ${validated.error}`);
    continue;
  }
  const result = validated.data;
  await call("po_generate_evidence", { case_id: caseId });
  let payload: unknown = {};
  if (result.eligible) {
    const built = await call<{ payload: unknown }>("po_build_payload", { case_id: caseId, package: read.data, derived: {} });
    if (built.ok) payload = built.data.payload;
  }
  let createResult: Envelope<{ po_number: string; idempotent: boolean }> | null = null;
  createResult = await call("po_create", { case_id: caseId, payload, confirmed: false });
  let poLabel = createResult.ok ? createResult.data.po_number : result.blockers.length ? "blocked" : "awaiting confirmation";

  if (caseId === "req-001" && createResult.ok) {
    const retry = await call<{ po_number: string; idempotent: boolean }>("po_create", { case_id: caseId, payload, confirmed: false });
    poLabel += retry.ok ? `; retry ${retry.data.po_number} (idempotent=${retry.data.idempotent})` : "; retry failed";
  }
  if (caseId === "req-004" && result.eligible && result.confirmations.length > 0) {
    const confirmed = await runTool("po_create", { case_id: caseId, payload, confirmed: true }, { ...context, confirmationGranted: true });
    const confirmationResult = confirmed.result as Envelope<{ po_number: string; idempotent: boolean }>;
    poLabel = confirmationResult.ok ? `${confirmationResult.data.po_number} (analyst confirmed)` : `confirmation failed: ${confirmationResult.error}`;
  }
  const blockers = result.blockers.length ? result.blockers.map((item) => item.code).join(", ") : "none";
  const confirmations = result.confirmations.length ? result.confirmations.map((item) => item.code).join(", ") : "none";
  console.log(`${caseId}: eligible=${result.eligible}; blockers=${blockers}; confirmations=${confirmations}; retroactive=${result.retroactive}; PO=${poLabel}`);
}

console.log(`\nArtifacts written under ${path.join(directory, "out")}`);
