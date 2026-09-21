import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stockLots, workOrders, workOrderTasks } from "@/db/schema";

/**
 * What a scanned code means.
 *
 * The codes a person can present at a station are deliberately few, because every
 * extra format is another way for a scan to do the wrong thing:
 *
 *   OP-482        a single step on a traveler — the one the operator is stood at
 *   WO-260920-001 a whole work order, parent or sub-assembly
 *   307290-4      a stock batch, already used by the inventory screen
 *
 * `ScanInput` reads the code; this decides what it refers to. Nothing here starts
 * or finishes work — resolving a code and acting on it stay separate, so a bad scan
 * cannot clock somebody on to the wrong job.
 */

export type ScanTarget =
  | { kind: "operation"; operationId: number; orderId: number; label: string }
  | { kind: "order"; orderId: number; label: string }
  | { kind: "lot"; batchNumber: string; itemId: number; label: string }
  | { kind: "unknown"; code: string };

/** The code printed on a traveler for one step. */
export function operationCode(operationId: number): string {
  return `OP-${operationId}`;
}

export function parseOperationCode(code: string): number | null {
  const m = /^OP-(\d{1,9})$/i.exec(code.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function resolveScan(raw: string): Promise<ScanTarget> {
  const code = raw.trim();
  if (!code) return { kind: "unknown", code };

  const operationId = parseOperationCode(code);
  if (operationId !== null) {
    const [row] = await db
      .select({
        id: workOrderTasks.id,
        name: workOrderTasks.name,
        orderId: workOrders.id,
        orderNumber: workOrders.orderNumber,
      })
      .from(workOrderTasks)
      .innerJoin(workOrders, eq(workOrderTasks.workOrderId, workOrders.id))
      .where(eq(workOrderTasks.id, operationId));
    if (row) {
      return {
        kind: "operation",
        operationId: row.id,
        orderId: row.orderId,
        label: `${row.name} · ${row.orderNumber}`,
      };
    }
    return { kind: "unknown", code };
  }

  const [order] = await db
    .select({ id: workOrders.id, orderNumber: workOrders.orderNumber })
    .from(workOrders)
    .where(eq(workOrders.orderNumber, code));
  if (order) return { kind: "order", orderId: order.id, label: order.orderNumber };

  const [lot] = await db
    .select({ batchNumber: stockLots.batchNumber, itemId: stockLots.itemId })
    .from(stockLots)
    .where(eq(stockLots.batchNumber, code));
  if (lot?.batchNumber) {
    return { kind: "lot", batchNumber: lot.batchNumber, itemId: lot.itemId, label: lot.batchNumber };
  }

  return { kind: "unknown", code };
}
