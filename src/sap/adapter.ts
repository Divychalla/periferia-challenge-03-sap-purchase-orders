import type { PurchaseOrder } from "../domain.js";

export interface SapAdapter {
  lookupSupplier(taxId: string): Promise<{ sap_code: string; active: boolean } | null>;
  createOrder(order: PurchaseOrder): Promise<{ po_number: string; date: string }>;
  findOrderByReference(requestId: string): Promise<{ po_number: string } | null>;
}
