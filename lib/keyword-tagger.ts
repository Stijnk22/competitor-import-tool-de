/**
 * Keyword tagger
 *
 * Automatically determines, for each uploaded keyword batch, which
 * attribute slot (core_product, material, closure_style, ...) each
 * keyword belongs to. This saves the user from manually tagging
 * thousands of rows.
 *
 * Also supports bulk mode (tagKeywordsBulk), for uploads that mix many
 * different product categories in one file — the AI determines both the
 * category AND the attribute slot per keyword, so the user doesn't need
 * to pre-split the file into one CSV per category.
 *
 * Processed in batches of 60 keywords per AI call to keep the prompt
 * manageable.
 */

import { callClaude, parseJsonResponse } from "./ai-client";
import type { ParsedKeywordRow } from "./keyword-csv-parser";

export type AttributeSlot =
  | "core_product"
  | "material"
  | "closure_style"
  | "heel_style"
  | "toe_style"
  | "silhouette"
  | "fit"
  | "neckline"
  | "sleeve_length"
  | "pattern"
  | "occasion"
  | "combo_longtail"
  | "other";

export type TaggedKeyword = ParsedKeywordRow & { attributeSlot: AttributeSlot };
export type BulkTaggedKeyword = ParsedKeywordRow & { attributeSlot: AttributeSlot; category: string };

const BATCH_SIZE = 60;
const ATTRIBUTE_SLOT_DEFINITIONS = `- core_product: the core product noun itself, with or without "women's"/"men's" (e.g. "heels", "women's heels", "dress", "midi dress" if "midi" is really just describing length as part of the core noun phrase)
- material: fabric/material descriptor (e.g. "leather", "suede", "cotton linen")
- closure_style: how it fastens (e.g. "ankle strap", "lace-up", "zip-up", "buckle")
- heel_style: heel shape/type — shoes only (e.g. "stiletto", "block heel", "kitten heel")
- toe_style: toe shape — shoes only (e.g. "peep-toe", "pointed-toe", "round-toe")
- silhouette: overall shape/fit (e.g. "A-line", "relaxed-fit", "slim-fit", "oversized")
- fit: length/fit descriptor distinct from silhouette (e.g. "midi", "maxi", "cropped", "high-waisted")
- neckline: neckline type — tops/dresses only (e.g. "V-neck", "crew-neck", "off-shoulder")
- sleeve_length: sleeve length — tops/dresses only (e.g. "short-sleeve", "long-sleeve", "sleeveless")
- pattern: print/pattern (e.g. "floral", "striped", "polka dot")
- occasion: the event/use-case the product is suited for, not a visual trait (e.g. "wedding guest", "cocktail", "party", "work", "summer", "evening", "holiday", "date night")
- combo_longtail: a keyword combining 2+ attributes into one phrase (e.g. "leather ankle strap heels", "black midi wrap dress")
- other: doesn't clearly fit any slot above, too generic, or not useful for a product title`;

const SYSTEM_PROMPT = `You are helping build a keyword library for Google Shopping SEO in the fashion e-commerce industry. You'll be given a product category and a list of keywords (with their search volumes). Classify EACH keyword into exactly one attribute slot, based on what part of a product title formula it would fill:

Title formula: [BRAND] | [GENDER] [ATTRIBUTE] [ATTRIBUTE] [ATTRIBUTE] [CORE PRODUCT TYPE]

Attribute slots:
${ATTRIBUTE_SLOT_DEFINITIONS}

Respond with ONLY valid JSON, no markdown, no preamble:
{ "tags": [ { "keyword": string, "attributeSlot": string } ] }
The array must have exactly one entry per input keyword, in the same order, with the exact original keyword text.`;

/**
 * For bulk uploads that mix many different product categories in one file
 * (e.g. a broad keyword-research export covering dresses, heels, boots,
 * jeans, etc. all at once). The AI determines BOTH the product category
 * AND the attribute slot for each keyword, so the user doesn't have to
 * manually split the file into one CSV per category first.
 */
const BULK_SYSTEM_PROMPT = `You are helping build a keyword library for Google Shopping SEO in the fashion e-commerce industry. You'll be given a list of keywords (with their search volumes) covering MULTIPLE different product categories mixed together (e.g. dresses, heels, boots, jeans, tops, all in one list). For EACH keyword, determine TWO things:

1. "category": which product category this keyword belongs to. Use a simple, standard, lowercase, plural product-type name (e.g. "dresses", "heels", "sandals", "boots", "flats", "trainers", "tops", "jeans", "skirts", "jumpsuits", "jumpers", "blazers", "jackets", "bikinis", "swimsuits", "leggings", "pumps", "coats"). If a keyword IS itself a core product type (e.g. "boots", "trainers"), that word (pluralized, lowercase) is the category.
2. "attributeSlot": exactly one attribute slot within that category, based on what part of a product title formula it would fill:

${ATTRIBUTE_SLOT_DEFINITIONS}

Respond with ONLY valid JSON, no markdown, no preamble:
{ "tags": [ { "keyword": string, "category": string, "attributeSlot": string } ] }
The array must have exactly one entry per input keyword, in the same order, with the exact original keyword text.`;

async function tagBatchBulk(batch: ParsedKeywordRow[], isRetry = false): Promise<BulkTaggedKeyword[]> {
  try {
    const responseText = await callClaude({
      system: BULK_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Keywords:\n${batch.map((k) => `${k.keyword} (volume: ${k.avgMonthlySearches})`).join("\n")}`,
        },
      ],
      maxTokens: 8000,
    });

    const parsed = parseJsonResponse<{ tags: { keyword: string; category: string; attributeSlot: string }[] }>(
      responseText
    );

    const tagByKeyword = new Map(parsed.tags.map((t) => [t.keyword, t]));

    const results = batch.map((row) => {
      const tag = tagByKeyword.get(row.keyword);
      return {
        ...row,
        category: (tag?.category || "uncategorized").toLowerCase().trim(),
        attributeSlot: (tag?.attributeSlot as AttributeSlot) || "other",
      };
    });

    const unmatched = results.filter((r) => r.category === "uncategorized");
    if (unmatched.length > 0) {
      console.warn(
        `[keyword-tagger] ${unmatched.length}/${batch.length} keywords in this batch had no matching tag in the AI response (likely wording mismatch):`,
        unmatched.map((r) => r.keyword)
      );
    }

    return results;
  } catch (err) {
    console.error(
      `[keyword-tagger] Bulk batch of ${batch.length} keywords failed${isRetry ? " (retry also failed)" : ", retrying once"}. Error:`,
      err
    );
    // One automatic retry — a single failed API call/parse shouldn't
    // permanently lose a whole batch of keywords.
    if (!isRetry) {
      return tagBatchBulk(batch, true);
    }
    // Retry also failed: mark as "other"/"uncategorized" instead of
    // failing the whole upload — the user can always correct this later.
    return batch.map((row) => ({ ...row, category: "uncategorized", attributeSlot: "other" as AttributeSlot }));
  }
}

/**
 * Tags a full list of keywords (in batches) with BOTH their product
 * category and attribute slot — for bulk uploads that mix many
 * categories in one file. See BULK_SYSTEM_PROMPT for details.
 *
 * Uses a smaller batch size than the single-category tagger: each entry
 * now needs both a category AND an attribute slot in the response, so
 * batches need more output tokens per keyword — a smaller batch size
 * keeps this comfortably within the token budget and, if a batch does
 * fail, limits how many keywords fall back to "uncategorized" at once.
 *
 * Processes a LIMITED NUMBER of batches concurrently (not all at once) —
 * important at scale (e.g. thousands of keywords = hundreds of batches):
 * firing them all simultaneously risks hitting Anthropic's rate limits,
 * which would cause many batches to fail at once for a completely
 * different reason than the token-budget issue this was already built to
 * avoid. An optional progress callback lets the caller report live
 * progress for large uploads.
 */
const BULK_BATCH_SIZE = 30;
const BULK_CONCURRENCY = 5;

export async function tagKeywordsBulk(
  rows: ParsedKeywordRow[],
  onProgress?: (processed: number, total: number) => void
): Promise<BulkTaggedKeyword[]> {
  const batches: ParsedKeywordRow[][] = [];
  for (let i = 0; i < rows.length; i += BULK_BATCH_SIZE) {
    batches.push(rows.slice(i, i + BULK_BATCH_SIZE));
  }

  console.log(
    `[keyword-tagger] Bulk tagging ${rows.length} keywords in ${batches.length} batches of up to ${BULK_BATCH_SIZE}, ${BULK_CONCURRENCY} at a time`
  );

  const results: BulkTaggedKeyword[][] = new Array(batches.length);
  let nextBatchIndex = 0;
  let processedKeywords = 0;

  async function worker() {
    while (nextBatchIndex < batches.length) {
      const myIndex = nextBatchIndex++;
      const batch = batches[myIndex];
      results[myIndex] = await tagBatchBulk(batch);
      processedKeywords += batch.length;
      onProgress?.(processedKeywords, rows.length);
    }
  }

  const workerCount = Math.min(BULK_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const flat = results.flat();
  const uncategorizedCount = flat.filter((r) => r.category === "uncategorized").length;
  console.log(`[keyword-tagger] Bulk tagging complete: ${flat.length - uncategorizedCount}/${flat.length} categorized successfully`);
  return flat;
}

async function tagBatch(category: string, batch: ParsedKeywordRow[]): Promise<TaggedKeyword[]> {
  try {
    const responseText = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Product category: ${category}\n\nKeywords:\n${batch
            .map((k) => `${k.keyword} (volume: ${k.avgMonthlySearches})`)
            .join("\n")}`,
        },
      ],
      maxTokens: 4000,
    });

    const parsed = parseJsonResponse<{ tags: { keyword: string; attributeSlot: string }[] }>(responseText);

    const tagByKeyword = new Map(parsed.tags.map((t) => [t.keyword, t.attributeSlot]));

    return batch.map((row) => ({
      ...row,
      attributeSlot: (tagByKeyword.get(row.keyword) as AttributeSlot) || "other",
    }));
  } catch {
    // On error: tag everything as "other" instead of failing the whole
    // upload — the user can always correct this later.
    return batch.map((row) => ({ ...row, attributeSlot: "other" as AttributeSlot }));
  }
}

/**
 * Tags a full list of keywords (in batches) with their attribute slot.
 */
export async function tagKeywords(category: string, rows: ParsedKeywordRow[]): Promise<TaggedKeyword[]> {
  const batches: ParsedKeywordRow[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE));
  }

  const results = await Promise.all(batches.map((batch) => tagBatch(category, batch)));
  return results.flat();
}
