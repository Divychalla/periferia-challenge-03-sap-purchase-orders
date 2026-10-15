import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PurchaseOrder } from "../domain.js";
import type { SapAdapter } from "./adapter.js";

type StoredOrder = { po_number: string; date: string; order: PurchaseOrder };

export class FileSapAdapter implements SapAdapter {
  constructor(private readonly directory: string) {}

  private get ordersPath(): string {
    return path.join(this.directory, "out", "sap", "orders.jsonl");
  }

  async lookupSupplier(taxId: string): Promise<{ sap_code: string; active: boolean } | null> {
    const text = await readFile(path.join(this.directory, "fixtures/challenge-03/master-data/suppliers.json"), "utf8");
    const suppliers = JSON.parse(text) as Array<{ sap_code: string; tax_id: string; active: boolean }>;
    const normalized = taxId.replace(/\D/g, "");
    const match = suppliers.find((item) => item.tax_id.replace(/\D/g, "") === normalized);
    return match ? { sap_code: match.sap_code, active: match.active } : null;
  }

  async findOrderByReference(requestId: string): Promise<{ po_number: string } | null> {
    const orders = await this.readOrders();
    const existing = orders.find((row) => row.order.reference.request_id === requestId);
    return existing ? { po_number: existing.po_number } : null;
  }

  async createOrder(order: PurchaseOrder): Promise<{ po_number: string; date: string }> {
    await mkdir(path.dirname(this.ordersPath), { recursive: true });
    const existing = await this.findOrderByReference(order.reference.request_id);
    if (existing) return { po_number: existing.po_number, date: "existing" };

    const orders = await this.readOrders();
    const next = 4500000001 + orders.length;
    const result = { po_number: String(next), date: new Date().toISOString() };
    const stored: StoredOrder = { ...result, order };
    await appendFile(this.ordersPath, `${JSON.stringify(stored)}\n`, "utf8");
    return result;
  }

  private async readOrders(): Promise<StoredOrder[]> {
    try {
      const text = await readFile(this.ordersPath, "utf8");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as StoredOrder);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
