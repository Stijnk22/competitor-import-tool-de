/**
 * Batch processor
 *
 * Processes all URLs of a batch: scrape -> AI-optimize (or AI-rephrase) ->
 * import to Shopify, per item. Runs with a limited number of concurrent
 * items (rather than all at once) to avoid hitting rate limits at Shopify
 * or Anthropic.
 */

import { scrapeCompetitorProduct } from "./scraper";
import { generateOptimizedContent, generateRephrasedContent } from "./content-optimizer";
import { importProductToShopify, type ContentOverrides, type PricingOptions } from "./product-importer";
import { getBatch, updateItem } from "./batch-store";
import { getStoreWithCredentials } from "./store-manager";
import type { LanguageCode } from "./languages";

const MAX_CONCURRENCY = 2;

async function processSingleItem(batchId: string, itemId: string) {
  const batch = getBatch(batchId);
  if (!batch) return;
  const item = batch.items.find((i) => i.id === itemId);
  if (!item) return;

  updateItem(batchId, itemId, { status: "processing" });

  try {
    const store = await getStoreWithCredentials(batch.storeId);
    if (!store) {
      updateItem(batchId, itemId, { status: "failed", failureReason: "Selected store not found." });
      return;
    }

    const scrapeResult = await scrapeCompetitorProduct(item.sourceUrl);
    if (!scrapeResult.success) {
      updateItem(batchId, itemId, { status: "failed", failureReason: scrapeResult.reason });
      return;
    }

    // Rephrase mode: keep the existing title/description but reword them
    // (same keywords, different structure) instead of writing brand-new
    // optimized copy. Everything else about the import is identical.
    const optimized = batch.rephraseMode
      ? await generateRephrasedContent(scrapeResult.product, store.name, batch.language as LanguageCode)
      : await generateOptimizedContent(scrapeResult.product, store.name, batch.language as LanguageCode);

    const overrides: ContentOverrides = {
      title: optimized.title,
      descriptionHtml: optimized.descriptionHtml,
      handle: optimized.slug,
      seoTitle: optimized.metaTitle,
      seoDescription: optimized.metaDescription,
      coreProductType: optimized.coreProductTypeEnglish,
      gender: optimized.gender,
    };

    const pricing: PricingOptions = {
      adjustmentEur: batch.priceAdjustmentEur,
      discountType: batch.discountType,
    };

    const importResult = await importProductToShopify(
      scrapeResult.product,
      store.shopifyDomain,
      store.accessToken,
      store.name,
      batch.language as LanguageCode,
      item.sourceUrl,
      batch.productStatus,
      overrides,
      pricing,
      batch.rephraseMode // skipSizeChart: in rephrase mode the size chart is already in the reworded description
    );

    if (importResult.success) {
      updateItem(batchId, itemId, {
        status: "success",
        shopifyProductId: importResult.productId,
        shopifyAdminUrl: importResult.adminUrl,
        collectionNote: importResult.collectionNote,
        currencyNote: importResult.currencyNote,
        resultTitle: optimized.title,
      });
    } else {
      updateItem(batchId, itemId, { status: "failed", failureReason: importResult.reason });
    }
  } catch (err) {
    updateItem(batchId, itemId, {
      status: "failed",
      failureReason: err instanceof Error ? err.message : "Unknown error during processing.",
    });
  }
}

/**
 * Processes all items of a batch. Runs "fire-and-forget" in the
 * background within the same process — the caller doesn't need to wait
 * for this, progress is tracked via batch-store and can be polled by the
 * frontend.
 */
export async function processBatchInBackground(batchId: string) {
  const batch = getBatch(batchId);
  if (!batch) return;

  const queue = [...batch.items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      await processSingleItem(batchId, item.id);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENCY, batch.items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
