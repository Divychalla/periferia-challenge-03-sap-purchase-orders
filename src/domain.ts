import { z } from "zod";

export const RequestSchema = z.object({
  request_id: z.string(),
  requester: z.string(),
  supplier_name: z.string(),
  supplier_tax_id: z.string().optional(),
  description: z.string(),
  cost_center: z.string(),
  subarea: z.string(),
  quantity: z.number(),
  unit_price: z.number(),
  total_value: z.number(),
  currency: z.enum(["COP", "USD"]),
  tax_code: z.string().optional(),
  payment_terms: z.string().optional(),
  request_date: z.string(),
});

export const PackageSchema = z.object({
  email: z.object({ id: z.string(), from: z.string(), subject: z.string(), date: z.string() }),
  request: RequestSchema,
  quote: z.object({
    supplier: z.string(),
    tax_id: z.string().nullable(),
    total: z.number(),
    currency: z.string(),
    valid_until: z.string().nullable(),
    reference: z.string().nullable(),
    text: z.string(),
  }).nullable(),
  approval: z.object({
    from: z.string(),
    to: z.string(),
    date: z.string(),
    subject: z.string(),
    approved: z.boolean(),
    text: z.string(),
  }).nullable(),
  invoice: z.object({ number: z.string(), date: z.string(), total: z.number() }).nullable(),
  missing: z.array(z.string()),
});

export type PurchaseRequest = z.infer<typeof RequestSchema>;
export type PurchasePackage = z.infer<typeof PackageSchema>;

export const PurchaseOrderSchema = z.object({
  reference: z.object({ request_id: z.string(), email_id: z.string(), quote_ref: z.string().nullable() }),
  company_code: z.literal("1000"),
  purchasing_org: z.literal("1000"),
  supplier: z.object({ sap_code: z.string(), tax_id: z.string(), name: z.string() }),
  currency: z.enum(["COP", "USD"]),
  payment_terms: z.string(),
  approver: z.object({ email: z.string(), approval_date: z.string(), evidence_sha256: z.string() }),
  items: z.array(z.object({
    number: z.number().int(),
    description: z.string().max(40),
    quantity: z.number().positive(),
    unit: z.enum(["EA", "H", "MON"]),
    unit_price: z.number().nonnegative(),
    cost_center: z.string(),
    subarea: z.string(),
    tax_code: z.string(),
  })).min(1),
  exceptions: z.array(z.object({ code: z.string(), detail: z.string(), confirmed_by: z.string().nullable() })),
});

export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

export type ValidationIssue = { code: string; detail: string };
export type ValidationResult = {
  eligible: boolean;
  blockers: ValidationIssue[];
  confirmations: ValidationIssue[];
  derived: {
    supplier: { sap_code: string; tax_id: string; name: string } | null;
    tax_code: string | null;
    payment_terms: string | null;
    approver: { email: string; approval_date: string; limit: number } | null;
  };
  retroactive: boolean;
};

export type ToolEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
