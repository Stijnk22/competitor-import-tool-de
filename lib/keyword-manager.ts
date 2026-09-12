/**
 * Keyword manager
 *
 * CRUD for the keyword library, plus the query used by the title optimizer
 * to fetch candidate keywords for a product.
 */

import { prisma } from "./db";
import type { TaggedKeyword, BulkTaggedKeyword } from "./keyword-tagger";

export type KeywordLibrarySummary = {
  market: string;
  category: string;
  count: number;
};

/**
 * Stores a tagged batch of keywords for a market + category. First
 * removes any existing entries for the same market+category (so a
 * re-upload cleanly replaces old data instead of stacking on top of it).
 */
export async function storeKeywords(market: string, category: string, tagged: TaggedKeyword[]): Promise<number> {
  await prisma.keywordLibraryEntry.deleteMany({ where: { market, category } });

  if (tagged.length === 0) return 0;

  const result = await prisma.keywordLibraryEntry.createMany({
    data: tagged.map((t) => ({
      market,
      category,
      attributeSlot: t.attributeSlot,
      keyword: t.keyword,
      searchVolume: t.avgMonthlySearches,
    })),
  });

  return result.count;
}

/**
 * Stores a bulk-tagged batch of keywords, where each keyword may belong to
 * a different (AI-detected) category — e.g. a single upload covering
 * dresses, heels, boots, etc. all at once. For every distinct category
 * found in the batch, existing entries for that market+category are first
 * removed (same replace-on-reupload behavior as storeKeywords, just
 * applied per detected category). Returns the total saved count plus a
 * breakdown per category, so the UI can show the user what was detected.
 */
export async function storeKeywordsBulk(
  market: string,
  tagged: BulkTaggedKeyword[]
): Promise<{ savedCount: number; categoryCounts: Record<string, number> }> {
  const byCategory = new Map<string, BulkTaggedKeyword[]>();
  for (const t of tagged) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }

  let savedCount = 0;
  const categoryCounts: Record<string, number> = {};

  for (const [category, entries] of byCategory) {
    await prisma.keywordLibraryEntry.deleteMany({ where: { market, category } });
    const result = await prisma.keywordLibraryEntry.createMany({
      data: entries.map((t) => ({
        market,
        category,
        attributeSlot: t.attributeSlot,
        keyword: t.keyword,
        searchVolume: t.avgMonthlySearches,
      })),
    });
    savedCount += result.count;
    categoryCounts[category] = result.count;
  }

  return { savedCount, categoryCounts };
}

/**
 * Overview of what's in the library, grouped by market + category — for
 * the dashboard.
 */
export async function listKeywordLibrarySummary(): Promise<KeywordLibrarySummary[]> {
  const grouped = await prisma.keywordLibraryEntry.groupBy({
    by: ["market", "category"],
    _count: { id: true },
    orderBy: [{ market: "asc" }, { category: "asc" }],
  });

  return grouped.map((g: { market: string; category: string; _count: { id: number } }) => ({
    market: g.market,
    category: g.category,
    count: g._count.id,
  }));
}

/** All distinct categories available for a market. */
export async function listCategoriesForMarket(market: string): Promise<string[]> {
  const rows = await prisma.keywordLibraryEntry.findMany({
    where: { market },
    select: { category: true },
    distinct: ["category"],
  });
  return rows.map((r: { category: string }) => r.category);
}

export type KeywordCandidate = {
  keyword: string;
  searchVolume: number;
  attributeSlot: string;
};

/**
 * Fetches all candidate keywords for a market + category, sorted by
 * search volume (highest first) — this is the input for the title
 * optimizer.
 */
export async function getKeywordCandidates(market: string, category: string): Promise<KeywordCandidate[]> {
  const rows = await prisma.keywordLibraryEntry.findMany({
    where: { market, category },
    orderBy: { searchVolume: "desc" },
    select: { keyword: true, searchVolume: true, attributeSlot: true },
  });
  return rows;
}

export async function deleteKeywordCategory(market: string, category: string): Promise<void> {
  await prisma.keywordLibraryEntry.deleteMany({ where: { market, category } });
}
