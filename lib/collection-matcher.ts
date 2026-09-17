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

const MULTI_SYSTEM_PROMPT = `You are a product categorization assistant for a fashion e-commerce store. You are given a product's title and product type, plus the store's full list of available collections. Your job is to pick ALL collections that genuinely fit this product — not just one.

A single product usually belongs in several collections at different levels of specificity. For example, a women's winter coat fits: a broad gender collection ("Damen"/"Women"), a mid-level garment collection ("Damen Jacken & Mäntel"/"Coats & Jackets"), AND a specific one ("Damen Winterjacken"/"Winter Coats"). Pick every collection from the list that is a sensible, correct fit — broad, mid, and specific.

Rules:
- Include a collection only if the product genuinely belongs in it. Don't force weak matches.
- Match on gender AND product type/category. A women's product should NOT go into men's collections and vice versa.
- Do not invent collections — only use exact titles from the provided list.
- It's fine to return many collections if they all fit, or just one, or none.

Respond with ONLY a valid JSON object, no markdown, no preamble:
{ "matchedCollections": ["<exact title>", "<exact title>", ...] }
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

    const wanted = new Set(parsed.matchedCollections.map((t) => t.toLowerCase()));
    return collections.filter((c) => wanted.has(c.title.toLowerCase()));
  } catch {
    return [];
  }
}

/**
 * Picks the best-fitting collection from the store's collection list, or
 * null if there's no good match. If the AI call fails, the result is also
 * null — a failed matching attempt must never break the whole import.
 */
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
