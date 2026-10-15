import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  PackageSchema,
  PurchaseOrderSchema,
  RequestSchema,
  type PurchaseOrder,
  type PurchasePackage,
  type ToolEnvelope,
  type ValidationIssue,
  type ValidationResult,
} from "../domain.js";
import { FileSapAdapter } from "../sap/mock.js";

export type ToolContext = { directory: string; sessionId: string; confirmationGranted?: boolean };
type Tool<Args extends z.ZodObject<z.ZodRawShape>> = {
  description: string;
  args: Args;
  execute(args: z.infer<Args>, ctx: ToolContext): Promise<string>;
};
type MasterSupplier = { sap_code: string; tax_id: string; name: string; default_payment_terms: string; default_tax_code: string; active: boolean };
type MasterApprover = { email: string; limit: number };
type MasterCostCenter = { cost_center: string; subareas: string[]; approvers: MasterApprover[] };
type MasterData = { suppliers: MasterSupplier[]; costCenters: MasterCostCenter[]; taxCodes: Array<{ code: string }>; paymentTerms: Array<{ code: string }> };

const CaseId = z.string().regex(/^req-00[1-6]$/, "Use a provided request id, such as req-001.");
const caseSchema = z.object({ case_id: CaseId.describe("Fixture folder id, for example req-001") });
const validateSchema = z.object({
  case_id: CaseId.describe("Fixture folder id, for example req-001"),
  package: z.unknown().describe("Normalized package returned by po_read_package"),
});
const buildSchema = z.object({
  case_id: CaseId.describe("Fixture folder id, for example req-001"),
  package: z.unknown().describe("Normalized package returned by po_read_package"),
  derived: z.unknown().describe("Derived values returned by po_validate"),
});
const createSchema = z.object({
  case_id: CaseId.describe("Fixture folder id, for example req-001"),
  payload: z.unknown().describe("Purchase order payload returned by po_build_payload"),
  confirmed: z.boolean().optional().describe("Confirmation flag; the server also checks the user's preceding chat turn"),
});

function tool<Args extends z.ZodObject<z.ZodRawShape>, Result>(
  name: string,
  description: string,
  args: Args,
  executeData: (input: z.infer<Args>, ctx: ToolContext) => Promise<Result>,
): Tool<Args> {
  return {
    description,
    args,
    async execute(input, ctx) {
      let caseId = "unknown";
      let envelope: ToolEnvelope<Result> | ToolEnvelope<never>;
      let ok = false;
      let summary = "completed";
      try {
        const parsed = args.parse(input);
        caseId = "case_id" in parsed && typeof parsed.case_id === "string" ? parsed.case_id : "unknown";
        const data = await executeData(parsed, ctx);
        envelope = { ok: true, data };
        ok = true;
        summary = summarize(name, caseId, data);
      } catch (error) {
        summary = userError(error);
        envelope = { ok: false, error: summary };
      }
      try {
        await writeAudit(ctx, name, caseId, ok, summary);
      } catch {
        if (ok) envelope = { ok: false, error: "The operation could not be recorded in the audit log." };
      }
      return JSON.stringify(envelope);
    },
  };
}

function caseDirectory(ctx: ToolContext, caseId: string): string {
  if (!CaseId.safeParse(caseId).success) throw new Error("Unknown request. Use req-001 through req-006.");
  return path.join(ctx.directory, "fixtures", "challenge-03", "requests", caseId);
}

async function readJson<T>(filePath: string, schema?: z.ZodType<T>): Promise<T> {
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  return schema ? schema.parse(value) : value as T;
}

function parseMoney(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function extractQuote(text: string): PurchasePackage["quote"] {
  const supplier = text.match(/^Supplier:\s*(.+)$/im)?.[1]?.trim();
  const taxId = text.match(/^Tax ID \(NIT\):\s*(.+)$/im)?.[1]?.trim() ?? null;
  const totalRaw = text.match(/^TOTAL[^\n]*:\s*(?:COP|USD)\s*([\d,.]+)/im)?.[1];
  const total = parseMoney(totalRaw);
  if (!supplier || total === null) throw new Error("The quote is missing its supplier or a readable total.");
  const currency = text.match(/^TOTAL[^\n]*:\s*(COP|USD)/im)?.[1] ?? "COP";
  const reference = text.match(/^QUOTE\s+([^\s]+)/im)?.[1] ?? null;
  const validityDays = Number(text.match(/^Offer validity:\s*(\d+)\s+days/im)?.[1] ?? 0);
  const quoteDate = text.match(/^Date:\s*(\d{4}-\d{2}-\d{2})/im)?.[1];
  let validUntil: string | null = null;
  if (quoteDate && validityDays > 0) {
    const date = new Date(`${quoteDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + validityDays);
    validUntil = date.toISOString().slice(0, 10);
  }
  return { supplier, tax_id: taxId, total, currency, valid_until: validUntil, reference, text };
}

async function readPackage(ctx: ToolContext, caseId: string): Promise<PurchasePackage> {
  const directory = caseDirectory(ctx, caseId);
  const request = await readJson(path.join(directory, "request.json"), RequestSchema);
  const email = await readJson<{ id: string; from: string; subject: string; date: string }>(path.join(directory, "email.json"));
  const missing: string[] = [];
  const quotePath = path.join(directory, "quote.txt");
  let quote: PurchasePackage["quote"] = null;
  try {
    quote = extractQuote(await readFile(quotePath, "utf8"));
  } catch (error) {
    if (isMissing(error)) missing.push("quote.txt");
    else throw error;
  }
  const approvalPath = path.join(directory, "approval.json");
  let approval: PurchasePackage["approval"] = null;
  try {
    const source = await readJson<{ from: string; to: string; date: string; subject: string; body: string }>(approvalPath);
    approval = { ...source, approved: /\bapproved\b/i.test(source.body), text: source.body };
  } catch (error) {
    if (isMissing(error)) missing.push("approval.json");
    else throw error;
  }
  const invoicePath = path.join(directory, "invoice.txt");
  let invoice: PurchasePackage["invoice"] = null;
  try {
    const text = await readFile(invoicePath, "utf8");
    const number = text.match(/Invoice No\.\s*(.+)/i)?.[1]?.trim();
    const date = text.match(/^Issue date:\s*(\d{4}-\d{2}-\d{2})/im)?.[1];
    const total = parseMoney(text.match(/^TOTAL:\s*(?:COP|USD)\s*([\d,.]+)/im)?.[1]);
    if (number && date && total !== null) invoice = { number, date, total };
    else missing.push("invoice.txt (unreadable)");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return PackageSchema.parse({
    email: { id: email.id, from: email.from, subject: email.subject, date: email.date },
    request,
    quote,
    approval,
    invoice,
    missing,
  });
}

async function readMaster(ctx: ToolContext): Promise<MasterData> {
  const root = path.join(ctx.directory, "fixtures", "challenge-03", "master-data");
  const [suppliers, costCenters, taxCodes, paymentTerms] = await Promise.all([
    readJson<MasterSupplier[]>(path.join(root, "suppliers.json")),
    readJson<MasterCostCenter[]>(path.join(root, "cost-centers.json")),
    readJson<Array<{ code: string }>>(path.join(root, "tax-codes.json")),
    readJson<Array<{ code: string }>>(path.join(root, "payment-terms.json")),
  ]);
  return { suppliers, costCenters, taxCodes, paymentTerms };
}

function normalizeName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function validatePackage(pkg: PurchasePackage, master: MasterData): ValidationResult {
  const blockers: ValidationIssue[] = [];
  const confirmations: ValidationIssue[] = [];
  const request = pkg.request;
  const requestTaxId = request.supplier_tax_id?.replace(/\D/g, "");
  const supplier = requestTaxId
    ? master.suppliers.find((item) => item.tax_id.replace(/\D/g, "") === requestTaxId)
    : master.suppliers.find((item) => normalizeName(item.name) === normalizeName(request.supplier_name));

  if (!supplier) blockers.push({ code: "RC1_SUPPLIER_NOT_FOUND", detail: `Supplier “${request.supplier_name}” is not in the master data. Ask purchasing to onboard the supplier or verify the tax ID.` });
  else if (!supplier.active) blockers.push({ code: "RC1_SUPPLIER_INACTIVE", detail: `Supplier “${supplier.name}” is inactive. Ask purchasing to confirm whether the supplier may be reactivated.` });

  const center = master.costCenters.find((item) => item.cost_center === request.cost_center);
  const approver = pkg.approval ? center?.approvers.find((item) => item.email.toLowerCase() === pkg.approval?.from.toLowerCase()) : undefined;
  if (!pkg.approval || !pkg.approval.approved || !approver) {
    blockers.push({ code: "RC2_APPROVAL_INVALID", detail: "Approval must contain “Approved” and come from an authorized approver for this cost center. Confirm the cost center or obtain approval from its listed approver." });
  }
  if (approver && request.total_value > approver.limit) {
    blockers.push({ code: "RC3_APPROVAL_LIMIT", detail: `The request total ${money(request.total_value, request.currency)} exceeds the approver limit ${money(approver.limit, request.currency)}. Obtain approval from an authorized approver with a sufficient limit.` });
  }
  if (!center || !center.subareas.some((item) => item.toLowerCase() === request.subarea.toLowerCase())) {
    blockers.push({ code: "RC4_SUBAREA_INVALID", detail: `Subarea “${request.subarea}” does not belong to cost center ${request.cost_center}. Correct the subarea or cost center in the request.` });
  }

  if (!pkg.quote) {
    confirmations.push({ code: "RC5_QUOTE_MISSING", detail: "No quote was provided. Confirm whether the request may proceed without it." });
  } else if (pkg.quote.currency !== request.currency) {
    confirmations.push({ code: "RC5_CURRENCY_MISMATCH", detail: `Request currency is ${request.currency}, while the quote is ${pkg.quote.currency}; confirm the amounts before proceeding.` });
  } else {
    const variance = Math.abs(pkg.quote.total - request.total_value) / Math.max(Math.abs(request.total_value), 1);
    if (variance > 0.02) {
      confirmations.push({ code: "RC5_QUOTE_VARIANCE", detail: `Request total is ${money(request.total_value, request.currency)}; quote total is ${money(pkg.quote.total, pkg.quote.currency)} (${(variance * 100).toFixed(2)}% variance).` });
    }
  }

  const taxCode = request.tax_code ?? supplier?.default_tax_code ?? null;
  if (!request.tax_code) {
    if (taxCode) confirmations.push({ code: "RC6_TAX_CODE_DERIVED", detail: `Tax code ${taxCode} was derived from the supplier master and requires confirmation.` });
    else blockers.push({ code: "RC6_TAX_CODE_UNAVAILABLE", detail: "No tax code was supplied and the supplier has no default tax code." });
  }
  if (taxCode && !master.taxCodes.some((item) => item.code === taxCode)) {
    blockers.push({ code: "RC6_TAX_CODE_UNKNOWN", detail: `Tax code ${taxCode} is not in the tax-code master.` });
  }

  const paymentTerms = request.payment_terms ?? supplier?.default_payment_terms ?? null;
  if (paymentTerms && !request.payment_terms && !master.paymentTerms.some((item) => item.code === paymentTerms)) {
    blockers.push({ code: "RC7_PAYMENT_TERMS_UNKNOWN", detail: `Derived payment terms ${paymentTerms} are not in the payment-terms master.` });
  }
  const retroactive = Boolean(pkg.invoice && pkg.invoice.date < request.request_date);
  if (retroactive) confirmations.push({ code: "RC8_RETROACTIVE", detail: `Invoice ${pkg.invoice?.number} is dated ${pkg.invoice?.date}, before request date ${request.request_date}.` });
  if (pkg.approval && dateOnly(pkg.approval.date) < request.request_date) {
    confirmations.push({ code: "RC9_APPROVAL_PRECEDES_REQUEST", detail: `Approval date ${dateOnly(pkg.approval.date)} is before request date ${request.request_date}.` });
  }
  if (Math.abs(request.quantity * request.unit_price - request.total_value) > 1) {
    blockers.push({ code: "RC10_AMOUNT_MISMATCH", detail: `Quantity × unit price is ${money(request.quantity * request.unit_price, request.currency)}, but request total is ${money(request.total_value, request.currency)}.` });
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    confirmations,
    derived: {
      supplier: supplier ? { sap_code: supplier.sap_code, tax_id: supplier.tax_id, name: supplier.name } : null,
      tax_code: taxCode,
      payment_terms: paymentTerms,
      approver: approver && pkg.approval ? { email: approver.email, approval_date: pkg.approval.date, limit: approver.limit } : null,
    },
    retroactive,
  };
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function money(value: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
}

async function generateEvidence(ctx: ToolContext, caseId: string): Promise<{ path: string; sha256: string }> {
  const pkg = await readPackage(ctx, caseId);
  if (!pkg.approval) throw new Error("Approval email is missing; evidence cannot be generated.");
  const content = [
    `From: ${pkg.approval.from}`,
    `To: ${pkg.approval.to}`,
    `Date: ${pkg.approval.date}`,
    `Subject: ${pkg.approval.subject}`,
    "",
    pkg.approval.text,
    "",
  ].join("\n");
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const output = path.join(ctx.directory, "out", caseId, "approval.txt");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, content, "utf8");
  return { path: path.relative(ctx.directory, output), sha256 };
}

async function traceablePayload(ctx: ToolContext, caseId: string, confirmed: boolean): Promise<{ payload: PurchaseOrder; traceabilityPath: string; validation: ValidationResult }> {
  const pkg = await readPackage(ctx, caseId);
  const master = await readMaster(ctx);
  const validation = validatePackage(pkg, master);
  if (!validation.eligible) throw new Error(`Cannot build a purchase order: ${validation.blockers.map((item) => item.detail).join(" ")}`);
  if (!pkg.approval || !validation.derived.supplier || !validation.derived.approver || !validation.derived.tax_code || !validation.derived.payment_terms) {
    throw new Error("Required master data or approval evidence is missing.");
  }
  const evidence = await generateEvidence(ctx, caseId);
  const exceptions = validation.confirmations.map((item) => ({
    code: item.code,
    detail: item.detail,
    confirmed_by: confirmed ? "chat-user" : null,
  }));
  const payload = PurchaseOrderSchema.parse({
    reference: { request_id: pkg.request.request_id, email_id: pkg.email.id, quote_ref: pkg.quote?.reference ?? null },
    company_code: "1000",
    purchasing_org: "1000",
    supplier: validation.derived.supplier,
    currency: pkg.request.currency,
    payment_terms: validation.derived.payment_terms,
    approver: { email: validation.derived.approver.email, approval_date: validation.derived.approver.approval_date, evidence_sha256: evidence.sha256 },
    items: [{
      number: 10,
      description: pkg.request.description.slice(0, 40),
      quantity: pkg.request.quantity,
      unit: "EA",
      unit_price: pkg.request.unit_price,
      cost_center: pkg.request.cost_center,
      subarea: pkg.request.subarea,
      tax_code: validation.derived.tax_code,
    }],
    exceptions,
  });
  const traceability = {
    request: {
      "reference.request_id": "request.request_id",
      "reference.email_id": "email.id",
      currency: "request.currency",
      "items[0].description": "request.description (truncated to SAP's 40-character short text limit)",
      "items[0].quantity": "request.quantity",
      "items[0].unit_price": "request.unit_price",
      "items[0].cost_center": "request.cost_center",
      "items[0].subarea": "request.subarea",
    },
    quote: { "reference.quote_ref": "quote.reference" },
    master: {
      "supplier.sap_code": "master-data/suppliers.json:sap_code",
      "supplier.tax_id": "master-data/suppliers.json:tax_id",
      "supplier.name": "master-data/suppliers.json:name",
      "approver.email": "master-data/cost-centers.json:approvers.email",
      "items[0].tax_code": pkg.request.tax_code ? "request.tax_code" : "master-data/suppliers.json:default_tax_code",
      payment_terms: pkg.request.payment_terms ? "request.payment_terms" : "master-data/suppliers.json:default_payment_terms",
      "approver.approval_date": "approval.date",
    },
    derived: { "approver.evidence_sha256": evidence.path },
  };
  const traceabilityPath = path.join(ctx.directory, "out", caseId, "traceability.json");
  await mkdir(path.dirname(traceabilityPath), { recursive: true });
  await writeFile(traceabilityPath, `${JSON.stringify(traceability, null, 2)}\n`, "utf8");
  return { payload, traceabilityPath: path.relative(ctx.directory, traceabilityPath), validation };
}

async function appendControl(
  ctx: ToolContext,
  caseId: string,
  result: string,
  poNumber: string | null,
  retroactive: boolean,
  blockers: ValidationIssue[],
  confirmations: ValidationIssue[],
  requestId: string,
): Promise<void> {
  const output = path.join(ctx.directory, "out", "control.csv");
  await mkdir(path.dirname(output), { recursive: true });
  const header = "request_id,result,po_number,retroactive,blockers,confirmations,ts\n";
  try {
    await readFile(output, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await writeFile(output, header, "utf8");
  }
  const values = [requestId || caseId, result, poNumber ?? "", String(retroactive), blockers.map((i) => i.code).join("|"), confirmations.map((i) => i.code).join("|"), new Date().toISOString()];
  await appendFile(output, `${values.map(csvCell).join(",")}\n`, "utf8");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function readRequestId(ctx: ToolContext, caseId: string): Promise<string> {
  try {
    const request = await readJson(path.join(caseDirectory(ctx, caseId), "request.json"), RequestSchema);
    return request.request_id;
  } catch {
    return caseId;
  }
}

async function writeAudit(ctx: ToolContext, name: string, caseId: string, ok: boolean, summary: string): Promise<void> {
  const file = path.join(ctx.directory, "out", "log.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), tool: name, sessionId: ctx.sessionId, case_id: caseId, ok, summary: summary.slice(0, 240) })}\n`, "utf8");
}

function summarize(name: string, caseId: string, value: unknown): string {
  if (typeof value !== "object" || value === null) return `${name} ${caseId}: completed`;
  if ("eligible" in value && "blockers" in value && "confirmations" in value) {
    const result = value as { eligible: boolean; blockers: unknown[]; confirmations: unknown[] };
    return `${name} ${caseId}: eligible=${result.eligible}; blockers=${result.blockers.length}; confirmations=${result.confirmations.length}`;
  }
  if ("po_number" in value && typeof value.po_number === "string") return `${name} ${caseId}: po=${value.po_number}`;
  if ("path" in value && typeof value.path === "string") return `${name} ${caseId}: ${value.path}`;
  return `${name} ${caseId}: completed`;
}

function userError(error: unknown): string {
  if (error instanceof z.ZodError) return `Input validation failed: ${error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`;
  if (isMissing(error)) return "The request package is incomplete: a required fixture file is missing.";
  return error instanceof Error ? error.message : "The tool could not complete this operation.";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export const read_package = tool("po_read_package", "Read and normalize one purchase request, its quote, approval and optional invoice.", caseSchema,
  async ({ case_id }, ctx) => readPackage(ctx, case_id));

export const validate = tool("po_validate", "Apply supplier, approval, cost-center, amount and confirmation controls to a request.", validateSchema,
  async ({ case_id }, ctx) => {
    const [pkg, master] = await Promise.all([readPackage(ctx, case_id), readMaster(ctx)]);
    return validatePackage(pkg, master);
  });

export const build_payload = tool("po_build_payload", "Build a Zod-validated SAP purchase order payload and write field-level traceability.", buildSchema,
  async ({ case_id }, ctx) => {
    const result = await traceablePayload(ctx, case_id, ctx.confirmationGranted === true);
    return { payload: result.payload, traceability_path: result.traceabilityPath };
  });

export const generate_evidence = tool("po_generate_evidence", "Generate the approval email evidence text file and return its SHA-256 hash.", caseSchema,
  async ({ case_id }, ctx) => generateEvidence(ctx, case_id));

export const create = tool("po_create", "Create an eligible purchase order in the simulated SAP adapter with idempotency and an audit row.", createSchema,
  async ({ case_id }, ctx) => {
    const pkg = await readPackage(ctx, case_id);
    const master = await readMaster(ctx);
    const validation = validatePackage(pkg, master);
    const requestId = pkg.request.request_id;
    if (!validation.eligible) {
      await appendControl(ctx, case_id, "blocked", null, validation.retroactive, validation.blockers, validation.confirmations, requestId);
      throw new Error(`Creation blocked: ${validation.blockers.map((item) => item.detail).join(" ")}`);
    }
    if (validation.confirmations.length > 0 && ctx.confirmationGranted !== true) {
      await appendControl(ctx, case_id, "pending_confirmation", null, validation.retroactive, [], validation.confirmations, requestId);
      throw new Error("Explicit confirmation is required in the user's immediately preceding chat turn.");
    }
    const built = await traceablePayload(ctx, case_id, ctx.confirmationGranted === true);
    const payload = PurchaseOrderSchema.parse(built.payload);
    const adapter = new FileSapAdapter(ctx.directory);
    const existing = await adapter.findOrderByReference(requestId);
    const result = await adapter.createOrder(payload);
    const idempotent = existing !== null;
    await appendControl(ctx, case_id, idempotent ? "idempotent" : "created", result.po_number, validation.retroactive, [], validation.confirmations, requestId);
    return { ...result, idempotent, retroactive: validation.retroactive };
  });

export const toolRegistry = {
  po_read_package: read_package,
  po_validate: validate,
  po_build_payload: build_payload,
  po_generate_evidence: generate_evidence,
  po_create: create,
};

export type ToolName = keyof typeof toolRegistry;
export type ToolCallResult = { name: ToolName; arguments: unknown; result: unknown };

export function getTool(name: string): (typeof toolRegistry)[ToolName] | undefined {
  return Object.prototype.hasOwnProperty.call(toolRegistry, name) ? toolRegistry[name as ToolName] : undefined;
}

export function openAiToolDefinitions(): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
  return Object.entries(toolRegistry).map(([name, definition]) => ({
    type: "function",
    function: { name, description: definition.description, parameters: z.toJSONSchema(definition.args) },
  }));
}

export async function resetOutput(ctx: ToolContext): Promise<void> {
  const output = path.join(ctx.directory, "out");
  const { rm } = await import("node:fs/promises");
  await rm(output, { recursive: true, force: true });
}

export async function runTool(name: ToolName, args: unknown, ctx: ToolContext): Promise<ToolCallResult> {
  const definition = getTool(name);
  if (!definition) return { name, arguments: args, result: { ok: false, error: "Unknown tool." } };
  let parsedArgs: unknown = args;
  try {
    parsedArgs = definition.args.parse(args);
  } catch {
    // execute returns a normalized validation error and writes the attempted call to the audit log.
  }
  const raw = await definition.execute(args as never, ctx);
  let result: unknown;
  try { result = JSON.parse(raw) as unknown; }
  catch { result = { ok: false, error: "The tool returned an invalid response." }; }
  return { name, arguments: parsedArgs, result };
}

export async function processDeterministically(caseId: string, ctx: ToolContext): Promise<{
  reply: string;
  toolCalls: ToolCallResult[];
  needsConfirmation: boolean;
  pendingCaseId?: string;
}> {
  const calls: ToolCallResult[] = [];
  const invoke = async (name: ToolName, args: unknown) => {
    const call = await runTool(name, args, ctx);
    calls.push(call);
    return call.result as { ok?: boolean; data?: unknown; error?: string };
  };
  const read = await invoke("po_read_package", { case_id: caseId });
  if (!read.ok) return { reply: read.error ?? "Could not read this request.", toolCalls: calls, needsConfirmation: false };
  const checked = await invoke("po_validate", { case_id: caseId, package: read.data });
  if (!checked.ok || !isValidation(checked.data)) return { reply: checked.error ?? "Could not validate this request.", toolCalls: calls, needsConfirmation: false };
  const validation = checked.data;
  if (!validation.eligible) {
    const blocked = await invoke("po_create", { case_id: caseId, payload: {}, confirmed: false });
    const blockedError = blocked.error ? `\n\n${blocked.error}` : "";
    return { reply: `Request ${caseId} is blocked.\n\n${validation.blockers.map((item) => `• ${item.code}: ${item.detail}`).join("\n")}${validation.confirmations.length ? `\n\nAlso needs confirmation:\n${validation.confirmations.map((item) => `• ${item.detail}`).join("\n")}` : ""}${blockedError}`, toolCalls: calls, needsConfirmation: false };
  }
  const evidence = await invoke("po_generate_evidence", { case_id: caseId });
  if (!evidence.ok) return { reply: evidence.error ?? "Could not create approval evidence.", toolCalls: calls, needsConfirmation: false };
  let payloadSummary = "";
  const payload = await invoke("po_build_payload", { case_id: caseId, package: read.data, derived: validation.derived });
  if (payload.ok && isPayloadData(payload.data)) {
    const request = (read.data as PurchasePackage).request;
    payloadSummary = `\n\nPayload preview: supplier ${payload.data.payload.supplier.name}, ${money(request.total_value, request.currency)}, cost center ${request.cost_center}. Evidence: ${(evidence.data as { path?: string }).path ?? "created"}.`;
  } else if (payload.error) return { reply: payload.error, toolCalls: calls, needsConfirmation: false };
  if (validation.confirmations.length > 0) {
    return {
      reply: `Request ${caseId} passed its blockers but needs your confirmation before SAP creation.\n\n${validation.confirmations.map((item) => `• ${item.code}: ${item.detail}`).join("\n")}${payloadSummary}\n\nDo you confirm creation of this purchase order?`,
      toolCalls: calls,
      needsConfirmation: true,
      pendingCaseId: caseId,
    };
  }
  const created = await invoke("po_create", { case_id: caseId, payload: {}, confirmed: false });
  if (!created.ok) return { reply: created.error ?? "Creation failed.", toolCalls: calls, needsConfirmation: false };
  const po = created.data as { po_number?: string; idempotent?: boolean };
  return { reply: `Purchase order ${po.po_number ?? "created"} is ${po.idempotent ? "already present (idempotent retry)" : "created"}.${payloadSummary}`, toolCalls: calls, needsConfirmation: false };
}

function isValidation(value: unknown): value is ValidationResult {
  return typeof value === "object" && value !== null && "eligible" in value && "blockers" in value && "confirmations" in value;
}

function isPayloadData(value: unknown): value is { payload: PurchaseOrder } {
  return typeof value === "object" && value !== null && "payload" in value && PurchaseOrderSchema.safeParse(value.payload).success;
}
