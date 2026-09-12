/**
 * Batch store
 *
 * Tracks the progress of a batch import in the memory of the running
 * server (no database needed for this purpose). This works well as long
 * as the server keeps running during a batch — exactly the use case we
 * need ("paste 50 URLs, follow progress live").
 *
 * Limitation: on a server restart (or a code change during `npm run dev`),
 * progress of running/completed batches is lost. For persistent history
 * across restarts, this would need to be replaced with database storage
 * (the schema for this already exists in prisma/schema.prisma, for a
 * future phase).
 */
import type { DiscountType } from "./price-calculator";
export type ImportItemStatus = "pending" | "processing" | "success" | "failed";
export type BatchImportItem = {
  id: string;
  sourceUrl: string;
  status: ImportItemStatus;
  failureReason?: string;
  shopifyProductId?: string;
  shopifyAdminUrl?: string;
  collectionNote?: string;
  currencyNote?: string;
  resultTitle?: string;
};
export type ImportBatch = {
  id: string;
  storeId: string;
  language: string;
  priceAdjustmentEur: number;
  productStatus: "DRAFT" | "ACTIVE";
  discountType: DiscountType | "none";
  rephraseMode: boolean;
  createdAt: number;
  items: BatchImportItem[];
};
// Module-level singleton: persists for as long as the Node process runs.
const batches = new Map<string, ImportBatch>();
export function createBatch(
  id: string,
  storeId: string,
  language: string,
  priceAdjustmentEur: number,
  urls: string[],
  productStatus: "DRAFT" | "ACTIVE" = "DRAFT",
  discountType: DiscountType | "none" = "50",
  rephraseMode: boolean = false
): ImportBatch {
  const items: BatchImportItem[] = urls.map((url, i) => ({
    id: `${id}-${i}`,
    sourceUrl: url,
    status: "pending",
  }));
  const batch: ImportBatch = {
    id,
    storeId,
    language,
    priceAdjustmentEur,
    productStatus,
    discountType,
    rephraseMode,
    createdAt: Date.now(),
    items,
  };
  batches.set(id, batch);
  return batch;
}
export function getBatch(id: string): ImportBatch | undefined {
  return batches.get(id);
}
export function updateItem(batchId: string, itemId: string, updates: Partial<BatchImportItem>) {
  const batch = batches.get(batchId);
  if (!batch) return;
  const item = batch.items.find((i) => i.id === itemId);
  if (!item) return;
  Object.assign(item, updates);
}
