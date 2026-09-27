/**
 * Collection matcher
 *
 * Fetches the existing collections of the selected store (every store has
 * its own collection structure, no fixed list) and lets Claude determine
 * which collection best fits this product, based on the (already
 * optimized) title and the product type.
 *
 * No match found -> no collection assigned, the tool returns this as a
 * "note" so the user sees the note field in the tool and can link it
 * manually later. This is never a hard failure: the product is imported
 * regardless.
 */

import { callClaude, parseJsonResponse } from "./ai-client";
import { shopifyGraphQL } from "./shopify-client";

export type StoreCollection = { id: string; title: string };

const COLLECTIONS_QUERY = `
  query GetStoreCollections {
    collections(first: 250) {
      nodes {
        id
        title
      }
    }
  }
`;

type CollectionsResponse = {
  collections: { nodes: StoreCollection[] };
};

/**
 * Fetches all collections of the store. Limited to the first 250 (more
 * than enough for most fashion stores); pagination can be added later if
 * a store has more than 250 collections.
 */
export async function fetchStoreCollections(
  storeDomain: string,
  accessToken: string
): Promise<StoreCollection[]> {
  const result = await shopifyGraphQL<CollectionsResponse>(storeDomain, accessToken, COLLECTIONS_QUERY);
  return result.collections.nodes;
}

const SYSTEM_PROMPT = `You are a product categorization assistant for a fashion e-commerce store. You are given a product's title and product type, plus the store's full list of available collections. Your job is to pick the SINGLE most appropriate collection for this product, based on gender (if apparent from the title, e.g. "Women's"/"Men's") and product type/category.

Only pick a collection if it is a genuinely good, sensible fit. If none of the available collections are clearly appropriate for this product, return null rather than forcing a weak match.

Respond with ONLY a valid JSON object, no markdown, no preamble:
{ "matchedCollection": "<exact collection title from the provided list>" }
or
{ "matchedCollection": null }`;

/**
 * Picks the best-fitting collection from the store's collection list, or
 * null if there's no good match. If the AI call fails, the result is also
 * null — a failed matching attempt must never break the whole import.
 */
const MULTI_SYSTEM_PROMPT = `You are a product categorization assistant for a fashion e-commerce store. You are given a product's title and product type, plus the store's full list of available collections. Your job is to pick ALL collections that genuinely fit this product — not just one.

A single product usually belongs in several collections at different levels of specificity. For example, a women's winter coat fits: a broad gender collection ("Women"), a mid-level garment collection ("Coats & Jackets"), AND a specific one ("Winter Coats"). Pick every collection from the list that is a sensible, correct fit — broad, mid, and specific.

Rules:
- Include a collection only if the product genuinely belongs in it. Don't force weak matches.
- Match on gender AND product type/category. A women's product should NOT go into men's collections and vice versa.
- Do not invent collections — only use exact titles from the provided list.
- It's fine to return many collections if they all fit, or just one, or none.

ORDER — CRITICAL: return the matched collections sorted from MOST SPECIFIC to LEAST SPECIFIC (i.e. narrowest product-type match first, broadest last). The most specific collection that directly names this product type should be first (e.g. for knee-high boots: "Knee-High Boots" first), then the next broader category (e.g. "Women Boots"), then broader still (e.g. "Women Shoes"), and a broad gender-only collection (e.g. "Women"/"Men") must ALWAYS be last. This ordering matters because the first item is used as the product's primary/related collection.

Respond with ONLY a valid JSON object, no markdown, no preamble:
{ "matchedCollections": ["<most specific exact title>", "<broader exact title>", ..., "<broadest exact title>"] }
or, if nothing fits:
{ "matchedCollections": [] }`;

/**
 * Picks ALL fitting collections from the store's list (broad, mid, and
 * specific), so a product is linked to every collection it belongs in —
 * not just the single best one. Returns an empty array on no match or on
 * error (a failed matching attempt must never break the import).
 */
export async function matchCollections(
  productTitle: string,
  productType: string,
  collections: StoreCollection[]
): Promise<StoreCollection[]> {
  if (collections.length === 0) return [];

  try {
    const responseText = await callClaude({
      system: MULTI_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Product title: ${productTitle}`,
                `Product type: ${productType}`,
                ``,
                `Available collections:`,
                ...collections.map((c) => `- ${c.title}`),
                ``,
                `Choose every collection that genuinely fits this product (broad, mid-level and specific).`,
              ].join("\n"),
            },
          ],
        },
      ],
      maxTokens: 400,
    });

    const parsed = parseJsonResponse<{ matchedCollections: string[] | null }>(responseText);
    if (!parsed.matchedCollections || parsed.matchedCollections.length === 0) return [];

    // Preserve the AI's order (most specific -> least specific) instead of
    // the store's own list order, because the FIRST item is used as the
    // product's primary/related collection. We map each returned title back
    // to the real store collection, keeping the AI's order and de-duping.
    const byTitle = new Map(collections.map((c) => [c.title.toLowerCase(), c]));
    const ordered: StoreCollection[] = [];
    const seen = new Set<string>();
    for (const title of parsed.matchedCollections) {
      const key = title.toLowerCase();
      const collection = byTitle.get(key);
      if (collection && !seen.has(key)) {
        ordered.push(collection);
        seen.add(key);
      }
    }

    // Safety net: never let a bare gender-only collection ("Women", "Men",
    // "Damen", "Herren", "Ladies", …) end up first, even if the AI ordered
    // it wrong. A stable sort pushes those to the very end, so the most
    // specific real category always stays the primary match — which is what
    // the Related Products metafield points at.
    ordered.sort((a, b) => Number(isBareGenderCollection(a.title)) - Number(isBareGenderCollection(b.title)));

    return ordered;
  } catch {
    return [];
  }
}

/**
 * True when a collection title is essentially just a gender word (no
 * product-type specificity), e.g. "Women", "Men's", "Damen", "Herren",
 * "Ladies". These are the broadest possible collections and must never be
 * treated as the specific/primary match for a product.
 */
function isBareGenderCollection(title: string): boolean {
  const normalized = title
    .toLowerCase()
    .replace(/['’]s\b/g, "") // "women's" -> "women"
    .replace(/[^a-zä-ü\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const GENDER_WORDS = new Set([
    "women", "woman", "womens", "ladies", "lady", "female",
    "men", "man", "mens", "male", "gentlemen",
    "damen", "dame", "frauen", "herren", "herr", "männer",
    "unisex", "all", "shop all", "alle",
  ]);
  return GENDER_WORDS.has(normalized);
}

export async function matchCollection(
  productTitle: string,
  productType: string,
  collections: StoreCollection[]
): Promise<StoreCollection | null> {
  if (collections.length === 0) return null;

  try {
    const responseText = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Product title: ${productTitle}`,
                `Product type: ${productType}`,
                ``,
                `Available collections:`,
                ...collections.map((c) => `- ${c.title}`),
                ``,
                `Choose the best fitting collection.`,
              ].join("\n"),
            },
          ],
        },
      ],
      maxTokens: 200,
    });

    const parsed = parseJsonResponse<{ matchedCollection: string | null }>(responseText);
    if (!parsed.matchedCollection) return null;

    return (
      collections.find((c) => c.title.toLowerCase() === parsed.matchedCollection!.toLowerCase()) ?? null
    );
  } catch {
    return null;
  }
}
