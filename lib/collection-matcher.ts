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
