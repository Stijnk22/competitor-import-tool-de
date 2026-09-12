/**
 * Category matcher
 *
 * Sets Shopify's own standardized product category (the "Category" field
 * at the top of a product, used for tax rates, filters, and cross-channel
 * sales) — this is different from the store-specific Collections already
 * handled in collection-matcher.ts.
 *
 * Approach: first search Shopify's taxonomy tree based on the product
 * type, then let Claude pick the best (ideally most specific) match from
 * the candidates.
 */

import { callClaude, parseJsonResponse } from "./ai-client";
import { shopifyGraphQL } from "./shopify-client";

const TAXONOMY_SEARCH_QUERY = `
  query SearchTaxonomy($search: String!) {
    taxonomy {
      categories(search: $search, first: 15) {
        edges {
          node {
            id
            fullName
            isLeaf
          }
        }
      }
    }
  }
`;

type TaxonomySearchResponse = {
  taxonomy: {
    categories: { edges: { node: { id: string; fullName: string; isLeaf: boolean } }[] };
  };
};

const SYSTEM_PROMPT = `You are a product categorization assistant working with Shopify's Standard Product Taxonomy. You are given a product's title and type, plus a list of candidate categories from the taxonomy (each with its full hierarchical path, e.g. "Apparel & Accessories > Clothing > Dresses"). Pick the SINGLE most accurate category for this product — prefer a specific leaf-level category over a broad parent category when both are reasonable options.

Only pick a category if it's a genuinely good fit. If none of the candidates are appropriate, return null rather than forcing a weak match.

Respond with ONLY valid JSON, no markdown, no preamble:
{ "matchedCategoryFullName": "<exact fullName from the provided list>" }
or
{ "matchedCategoryFullName": null }`;

/**
 * Searches for and picks the best-fitting Shopify taxonomy category for
 * this product. If the search or AI call fails, the result is null —
 * just like collection matching, this must never break the whole import.
 */
export async function matchTaxonomyCategory(
  storeDomain: string,
  accessToken: string,
  productTitle: string,
  productType: string
): Promise<string | null> {
  try {
    const searchTerm = productType || productTitle;
    console.log(`[category-matcher] Searching taxonomy with term: "${searchTerm}"`);

    const result = await shopifyGraphQL<TaxonomySearchResponse>(
      storeDomain,
      accessToken,
      TAXONOMY_SEARCH_QUERY,
      { search: searchTerm }
    );

    const candidates = result.taxonomy.categories.edges.map((e) => e.node);
    console.log(`[category-matcher] ${candidates.length} candidates found:`, candidates.map((c) => c.fullName));

    if (candidates.length === 0) {
      console.log("[category-matcher] No candidates — no category will be assigned.");
      return null;
    }

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
                `Candidate categories:`,
                ...candidates.map((c) => `- ${c.fullName}`),
              ].join("\n"),
            },
          ],
        },
      ],
      maxTokens: 200,
    });

    const parsed = parseJsonResponse<{ matchedCategoryFullName: string | null }>(responseText);
    console.log(`[category-matcher] Claude chose: ${parsed.matchedCategoryFullName ?? "(no match)"}`);

    if (!parsed.matchedCategoryFullName) return null;

    // Extra safety check: the chosen answer must exactly match one of the
    // REAL candidates returned by Shopify. We compare case-insensitively
    // and trimmed, so small formatting differences (spaces, capitalization)
    // don't cause a false "no match" — but a category that wasn't
    // literally in Shopify's candidate list is never used.
    const normalize = (s: string) => s.trim().toLowerCase();
    const match = candidates.find((c) => normalize(c.fullName) === normalize(parsed.matchedCategoryFullName!));

    if (!match) {
      console.log(
        `[category-matcher] Claude's answer didn't exactly match a candidate from Shopify's list — no category assigned.`
      );
      return null;
    }

    console.log(`[category-matcher] Resulting category ID (from Shopify's own list): ${match.id} (${match.fullName})`);
    return match.id;
  } catch (err) {
    console.error("[category-matcher] ERROR during category matching:", err);
    return null;
  }
}
