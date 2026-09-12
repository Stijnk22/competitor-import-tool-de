/**
 * Category metafield matcher
 *
 * Automatically fills in Shopify's "Category metafields" (the attribute
 * fields that appear once a product has a Category assigned — e.g.
 * Color, Neckline, Dress style — with the "Accept all" suggestions
 * button in the admin UI). These are a separate system from regular
 * custom metafields: values are metaobject references tied to Shopify's
 * product taxonomy, not plain text.
 *
 * The full resolution chain (confirmed via Shopify's official docs):
 *  1. Get the category's available attributes + allowed values from the
 *     taxonomy (e.g. "Color" -> ["Black", "Blue", "Green", ...], each
 *     with its own TaxonomyValue ID).
 *  2. Get the shop's actual category metafield definitions (namespace
 *     "shopify") to know the exact key for each attribute (e.g. "Color"
 *     -> key "color-pattern") — this is store-specific and depends on
 *     what category has been used before, so we ask Shopify directly
 *     rather than guessing.
 *  3. Ask Claude (grounded in the product photos) which value applies
 *     for each attribute, if any — same "skip if uncertain" approach
 *     used everywhere else in this tool.
 *  4. For the chosen value, look up its corresponding metaobject entry
 *     (Shopify's standard metaobjects, type "shopify--{key}", matched by
 *     their taxonomy_reference field) to get the metaobject GID that the
 *     metafield actually needs to reference.
 *  5. Return a list of ready-to-use metafield inputs.
 *
 * This is a best-effort, experimental feature — the API for this is
 * relatively new and less battle-tested than the plain Category field.
 * Any failure at any step is logged and simply skips that attribute,
 * never blocks the import.
 */

import { callClaude, parseJsonResponse, fetchImageAsBase64Block, type ClaudeContentBlock } from "./ai-client";
import { shopifyGraphQL } from "./shopify-client";

const CATEGORY_METAFIELD_DEFINITIONS_QUERY = `
  query GetCategoryMetafieldDefinitions {
    metafieldDefinitions(ownerType: PRODUCT, namespace: "shopify", first: 100) {
      nodes {
        name
        key
        type {
          name
        }
      }
    }
  }
`;

type MetafieldDefinitionsResponse = {
  metafieldDefinitions: {
    nodes: { name: string; key: string; type: { name: string } }[];
  };
};

const CATEGORY_ATTRIBUTES_QUERY = `
  query GetCategoryAttributes($id: ID!) {
    node(id: $id) {
      ... on TaxonomyCategory {
        attributes(first: 20) {
          nodes {
            ... on TaxonomyChoiceListAttribute {
              id
              name
              values(first: 50) {
                nodes {
                  id
                  name
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Some attributes (e.g. "Size") have more than 50 possible values in
// Shopify's taxonomy — this fetches any remaining pages for one specific
// attribute by its own ID, so we never silently miss values that just
// happen to fall after the first 50 (this is exactly what caused "S",
// "M", "L" to be missing from the Size candidate list).
const ATTRIBUTE_VALUES_PAGE_QUERY = `
  query GetAttributeValuesPage($id: ID!, $after: String) {
    node(id: $id) {
      ... on TaxonomyChoiceListAttribute {
        values(first: 50, after: $after) {
          nodes {
            id
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

type CategoryAttributesResponse = {
  node: {
    attributes: {
      nodes: {
        id?: string;
        name?: string;
        values?: {
          nodes: { id: string; name: string }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }[];
    };
  } | null;
};

type AttributeValuesPageResponse = {
  node: {
    values: {
      nodes: { id: string; name: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

export type CategoryMetafieldInput = {
  namespace: string;
  key: string;
  type: string;
  value: string;
};

const SYSTEM_PROMPT = `You are analyzing a fashion product to determine which category attribute values genuinely apply to it. You are given the product's photos AND the competitor's original title/description text — use BOTH sources of evidence, not just the photos.

You will be given a list of attributes, each with its real, allowed candidate values (from Shopify's own product taxonomy). For each attribute, pick EVERY candidate value that's genuinely, accurately applicable — usually this is just one, but some attributes can genuinely have more than one true value at once (e.g. an "Occasion" attribute might genuinely fit both "Casual" and "Everyday"). Never force multiple values just to fill space — only include a value if it's genuinely, independently true.

ABSOLUTE RULE — accuracy over completeness: only select a value if you are effectively certain it's correct. If there's real doubt or ambiguity, leave that attribute's list empty rather than making your best guess. A wrong metafield is actively harmful (it misleads the store, customers, and any channel that reads this data); an empty one is completely harmless and can always be filled in manually later. It is completely fine — expected, even — for most attributes to end up empty on a given product. Never fill something in "because it's probably right" or "because it's close enough" — only when you'd confidently defend it as fact.

CRITICAL RULES:
- The source text is often the ONLY reliable evidence for things that can't be judged from a photo — especially "Care instructions". NEVER contradict an explicit statement in the source text (e.g. if the text says "do not dry clean", never choose "Dry clean only" — choose whatever candidate matches what the text actually says instead, such as "Machine washable"). If the text says nothing relevant and it's not visually obvious, leave that attribute empty.
- For neckline/collar-type attributes: prioritize the primary, structural collar/neckline construction (e.g. "Collared", "Mandarin Collar", "Stand Collar") over an incidental secondary effect (e.g. a V-shaped gap created by unbuttoning the top button of a collared shirt is NOT a "V-neck" — the garment's actual neckline construction is the collar). Only choose "V-neck" when the garment is genuinely cut in a V-shape with no collar.
- For "Occasion"/formality attributes: don't default to "Formal" or "Party" unless the garment is clearly and specifically dressy (e.g. sequins, structured formalwear, cocktail-specific cut). A relaxed, flowing, everyday-wearable piece (even if elevated or "dressed up"-able) should get more general categories like "Casual", "Daywear", "Smart Casual", or "Holiday" instead. Ground this in both the visual style AND anything the source text says about how it's meant to be worn.
- If a "Color" attribute is included in this request (only happens when the product has no separate real color variants to go by instead), prefer a SPECIFIC dominant/base color (e.g. "White", "Black", "Green") over a generic "Multicolor" candidate whenever one clear base color genuinely dominates the garment — reserve "Multicolor" for pieces that are genuinely a mix of several similarly-prominent colors with no single dominant one.

Respond with ONLY valid JSON, no markdown, no preamble:
{ "selections": [ { "attributeName": string, "chosenValues": string[] } ] }
The array must have exactly one entry per attribute provided, in the same order. "chosenValues" is an empty array if nothing genuinely, confidently applies.`;

/**
 * Fetches the shop's category metafield definitions (namespace "shopify"),
 * so we know the exact metafield key + type for each attribute name. This
 * is store-specific (depends on which categories have been used before on
 * this store), so we always ask Shopify rather than guessing.
 */
async function getCategoryMetafieldDefinitions(
  storeDomain: string,
  accessToken: string
): Promise<Map<string, { key: string; type: string }>> {
  const result = await shopifyGraphQL<MetafieldDefinitionsResponse>(
    storeDomain,
    accessToken,
    CATEGORY_METAFIELD_DEFINITIONS_QUERY
  );
  const map = new Map<string, { key: string; type: string }>();
  for (const def of result.metafieldDefinitions.nodes) {
    map.set(def.name.toLowerCase(), { key: def.key, type: def.type.name });
  }
  console.log(
    `[category-metafield-matcher] ${map.size} category metafield definitions available on this store:`,
    [...map.entries()].map(([name, d]) => `${name} -> ${d.key} (${d.type})`)
  );
  return map;
}

/**
 * Fetches the choice-list attributes (and their allowed values) for a
 * taxonomy category. Only choice-list attributes are supported for now —
 * measurement attributes (numeric, e.g. weight) use a different format
 * and aren't handled by this module yet.
 *
 * Some attributes have MORE than 50 values (e.g. "Size", which spans
 * letter sizes, numeric sizes, plus sizes, and age-based sizes all at
 * once) — for those, this fetches every remaining page so nothing is
 * silently missed.
 */
async function getCategoryChoiceListAttributes(
  storeDomain: string,
  accessToken: string,
  taxonomyCategoryId: string
): Promise<{ id: string; name: string; values: { id: string; name: string }[] }[]> {
  const result = await shopifyGraphQL<CategoryAttributesResponse>(
    storeDomain,
    accessToken,
    CATEGORY_ATTRIBUTES_QUERY,
    { id: taxonomyCategoryId }
  );

  const rawAttributes = (result.node?.attributes.nodes ?? []).filter(
    (
      a
    ): a is {
      id: string;
      name: string;
      values: { nodes: { id: string; name: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } => Boolean(a.id && a.name && a.values)
  );

  const attributes = await Promise.all(
    rawAttributes.map(async (a) => {
      let values = [...a.values.nodes];
      let after = a.values.pageInfo.hasNextPage ? a.values.pageInfo.endCursor : null;

      while (after) {
        const pageResult = await shopifyGraphQL<AttributeValuesPageResponse>(
          storeDomain,
          accessToken,
          ATTRIBUTE_VALUES_PAGE_QUERY,
          { id: a.id, after }
        );
        const page = pageResult.node?.values;
        if (!page) break;
        values = values.concat(page.nodes);
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      }

      return { id: a.id, name: a.name, values };
    })
  );

  console.log(
    `[category-metafield-matcher] ${attributes.length} choice-list attributes found for this category:`,
    attributes.map((a) => `${a.name} (${a.values.length} values)`)
  );
  return attributes;
}

const METAOBJECTS_BY_TYPE_QUERY = `
  query GetMetaobjectsByType($type: String!, $after: String) {
    metaobjects(type: $type, first: 100, after: $after) {
      edges {
        node {
          id
          fields {
            key
            value
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type MetaobjectsByTypeResponse = {
  metaobjects: {
    edges: { node: { id: string; fields: { key: string; value: string | null }[] } }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// Caches all entries per metaobject type for the duration of this server
// process — avoids redundantly re-fetching the same ~20-50 entries for
// every product in a batch. Category metaobject entries change rarely.
const metaobjectEntriesCache = new Map<
  string,
  { taxonomyReferences: string[]; metaobjectId: string; fieldValues: string[] }[]
>();

/**
 * Fetches ALL entries of a given standard category metaobject type (e.g.
 * "shopify--color-pattern"), with the taxonomy value GID(s) each entry
 * corresponds to, plus all of its other field values (used to prefer an
 * English-labeled entry when a store has duplicate entries for the same
 * taxonomy value in different languages — see findMetaobjectGidForTaxonomyValue).
 * Filtering metaobjects by field value via the `query` parameter requires
 * that field to be marked filterable, which isn't reliably the case for
 * Shopify's own standard definitions — so instead we fetch the (small)
 * full list and match client-side, which works regardless of that setting.
 *
 * Some metaobject types (e.g. "color-pattern", which covers both color
 * AND pattern; "size", which can carry more than one size-system
 * reference on the same entry) can have MORE THAN ONE taxonomy-value-
 * shaped field per entry — so we capture ALL of them per entry, rather
 * than just the first one found, and match against any of them later.
 */
async function getMetaobjectEntriesForType(
  storeDomain: string,
  accessToken: string,
  metaobjectType: string
): Promise<{ taxonomyReferences: string[]; metaobjectId: string; fieldValues: string[] }[]> {
  // Only ever return early from cache if we previously found at least one
  // real entry. An empty result is deliberately NOT cached — if it was
  // empty due to a transient issue (e.g. a missing API scope that then
  // gets fixed), the next call will simply retry instead of being stuck
  // returning empty forever for the rest of this server's lifetime.
  const cached = metaobjectEntriesCache.get(metaobjectType);
  if (cached && cached.length > 0) return cached;

  const entries: { taxonomyReferences: string[]; metaobjectId: string; fieldValues: string[] }[] = [];
  let after: string | null = null;

  do {
    const result: MetaobjectsByTypeResponse = await shopifyGraphQL<MetaobjectsByTypeResponse>(
      storeDomain,
      accessToken,
      METAOBJECTS_BY_TYPE_QUERY,
      { type: metaobjectType, after }
    );

    for (const edge of result.metaobjects.edges) {
      // Extract EVERY taxonomy value GID found anywhere within each
      // field's value — using a regex match rather than a strict
      // .startsWith() check, since some fields store the GID as plain
      // text (e.g. "gid://shopify/TaxonomyValue/7") while others store it
      // JSON-array-wrapped as text (e.g. '["gid://shopify/TaxonomyValue/7"]',
      // seen on "color_taxonomy_reference" specifically). A regex finds
      // the GID either way, plus handles a field with multiple GIDs.
      const taxonomyReferences = edge.node.fields
        .filter((f): f is { key: string; value: string } => f.value !== null)
        .flatMap((f) => f.value.match(/gid:\/\/shopify\/TaxonomyValue\/\d+/g) ?? []);
      if (taxonomyReferences.length > 0) {
        entries.push({
          taxonomyReferences,
          metaobjectId: edge.node.id,
          fieldValues: edge.node.fields.map((f) => f.value).filter((v): v is string => v !== null),
        });
      }
    }

    after = result.metaobjects.pageInfo.hasNextPage ? result.metaobjects.pageInfo.endCursor : null;
  } while (after);

  console.log(`[category-metafield-matcher] Fetched ${entries.length} entries for metaobject type "${metaobjectType}"`);
  metaobjectEntriesCache.set(metaobjectType, entries);
  return entries;
}

/**
 * Resolves a chosen TaxonomyValue to its corresponding metaobject entry
 * GID — this is the actual value the metafield needs to reference.
 *
 * Some stores end up with MULTIPLE metaobject entries pointing to the
 * same taxonomy value, in different languages (e.g. "Adults" and
 * "Volwassenen" both referencing the same underlying "Adult" taxonomy
 * value) — this can happen depending on how/when the store's languages
 * were configured. If that happens, we deliberately prefer the entry
 * whose own field text matches the expected English candidate name, so
 * the tool consistently stores the English-labeled entry rather than
 * whichever one happens to come first from the API.
 */
async function findMetaobjectGidForTaxonomyValue(
  storeDomain: string,
  accessToken: string,
  metafieldKey: string,
  taxonomyValueId: string,
  expectedEnglishName: string
): Promise<string | null> {
  try {
    const entries = await getMetaobjectEntriesForType(storeDomain, accessToken, `shopify--${metafieldKey}`);
    const candidates = entries.filter((e) => e.taxonomyReferences.includes(taxonomyValueId));

    let match = candidates.length > 1
      ? candidates.find((c) => c.fieldValues.some((v) => v.toLowerCase() === expectedEnglishName.toLowerCase()))
      : candidates[0];

    // Fall back to the first candidate if none matched the English name
    // exactly (better to still set something than nothing).
    if (!match) match = candidates[0];

    if (candidates.length > 1) {
      console.log(
        `[category-metafield-matcher] Found ${candidates.length} duplicate entries for ${taxonomyValueId} — chose the one matching "${expectedEnglishName}".`
      );
    }

    console.log(
      `[category-metafield-matcher] Metaobject lookup for ${taxonomyValueId} (type shopify--${metafieldKey}):`,
      match?.metaobjectId ?? "(not found)"
    );
    return match?.metaobjectId ?? null;
  } catch (err) {
    console.error(`[category-metafield-matcher] Metaobject lookup failed for key "${metafieldKey}":`, err);
    return null;
  }
}

const OPTION_VALUE_MATCH_SYSTEM_PROMPT = `You are matching a fashion product's ACTUAL, REAL option values (as sold — e.g. real size labels like "S", "M", "UK 10", or real color names like "Forest Green", "Ivory") to Shopify's standardized taxonomy values for that same attribute.

You will be given the product's real option values, and the real, allowed candidate values from Shopify's taxonomy. For EACH real value, pick the single best-matching candidate (e.g. "S" -> "Small", "Forest Green" -> "Green") — or null if truly nothing matches. Never invent a candidate that isn't in the provided list.

Respond with ONLY valid JSON, no markdown, no preamble:
{ "matches": [ { "realValue": string, "matchedCandidate": string | null } ] }
The array must have exactly one entry per real value, in the same order.`;

/**
 * Resolves a product's ACTUAL, real option values (e.g. real size labels
 * "S"/"M", or real color names "Forest Green"/"Ivory" — from the scraped
 * variants, already 100% known/accurate) to Shopify's standardized
 * taxonomy values for that attribute. Deliberately NOT photo-based: for
 * an attribute the product already has real variant data for, that real
 * data is more complete and reliable than what a handful of photos
 * happen to show (e.g. a product with 6 color variants might only have
 * 2-3 of them visible across the scraped photos) — this is a simple,
 * reliable text-matching task instead of a visual guess.
 */
async function resolveOptionValues(
  attributeLabel: string,
  realValues: string[],
  candidateValues: { id: string; name: string }[]
): Promise<string[]> {
  if (realValues.length === 0 || candidateValues.length === 0) return [];

  console.log(
    `[category-metafield-matcher] ${attributeLabel} candidates offered to AI (${candidateValues.length} total):`,
    candidateValues.map((v) => v.name)
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const responseText = await callClaude({
        system: OPTION_VALUE_MATCH_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Real product ${attributeLabel.toLowerCase()} values: ${realValues.map((s) => `"${s}"`).join(", ")}\n\nCandidate taxonomy values: [${candidateValues.map((v) => `"${v.name}"`).join(", ")}]`,
          },
        ],
        maxTokens: 1500,
      });

      const parsed = parseJsonResponse<{ matches: { realValue: string; matchedCandidate: string | null }[] }>(
        responseText
      );
      console.log(`[category-metafield-matcher] ${attributeLabel} matches:`, parsed.matches);

      // De-duplicate — multiple real values could map to the same candidate.
      return [...new Set(parsed.matches.map((m) => m.matchedCandidate).filter((v): v is string => v !== null))];
    } catch (err) {
      console.error(`[category-metafield-matcher] ${attributeLabel} resolution attempt ${attempt} failed${attempt === 1 ? ", retrying once" : ""}:`, err);
    }
  }
  return [];
}

/**
 * Determines and resolves category metafields for a product. Returns a
 * list of ready-to-use metafield inputs (namespace "shopify"), or an
 * empty array if nothing could be determined — this must never block the
 * import, so every step degrades gracefully on failure.
 */
export async function determineCategoryMetafields(
  storeDomain: string,
  accessToken: string,
  taxonomyCategoryId: string,
  imageUrls: string[],
  productSizeValues: string[] = [],
  competitorTitle: string = "",
  competitorDescription: string = "",
  productColorValues: string[] = []
): Promise<CategoryMetafieldInput[]> {
  try {
    const [definitions, attributes] = await Promise.all([
      getCategoryMetafieldDefinitions(storeDomain, accessToken),
      getCategoryChoiceListAttributes(storeDomain, accessToken, taxonomyCategoryId),
    ]);

    // Only consider attributes that this store actually has a metafield
    // definition for (definitions get created automatically by Shopify
    // once a category is used, so this list grows over time).
    // "Fabric" is permanently excluded — never determined for any
    // product, per explicit instruction (fabric composition genuinely
    // can't be reliably confirmed from photos alone, and is too
    // consequential to guess at).
    const relevantAttributes = attributes.filter(
      (a) => definitions.has(a.name.toLowerCase()) && a.name.toLowerCase() !== "fabric"
    );
    console.log(
      `[category-metafield-matcher] ${relevantAttributes.length}/${attributes.length} attributes have a usable metafield definition on this store (Fabric always excluded).`
    );
    if (relevantAttributes.length === 0) return [];

    // "Size" is always handled separately (text-matched against the
    // real, known variant sizes) rather than visually guessed. "Color" is
    // handled the same way, but ONLY if the product actually has real
    // color variant values — a product's photos might not show every
    // color variant it comes in (e.g. 6 color variants but only 2-3
    // visible across the scraped images), so the real variant data is
    // more complete/reliable than a photo guess whenever it's available.
    // If there's no separate Color option (a single-color product), we
    // fall back to the normal photo-based determination for Color below.
    const hasRealColorValues = productColorValues.length > 0;
    const photoAttributes = relevantAttributes.filter(
      (a) => a.name.toLowerCase() !== "size" && !(hasRealColorValues && a.name.toLowerCase() === "color")
    );
    const sizeAttribute = relevantAttributes.find((a) => a.name.toLowerCase() === "size");
    const colorAttribute = relevantAttributes.find((a) => a.name.toLowerCase() === "color");

    const metafields: CategoryMetafieldInput[] = [];

    /** Shared helper: resolves an attribute from real, known option values (Size or Color) rather than a photo guess. */
    async function resolveFromRealValues(
      label: string,
      attribute: { name: string; values: { id: string; name: string }[] } | undefined,
      realValues: string[]
    ) {
      if (!attribute || realValues.length === 0) return;
      const matchedNames = await resolveOptionValues(label, realValues, attribute.values);
      const definition = definitions.get(attribute.name.toLowerCase());
      if (!definition || matchedNames.length === 0) return;

      const gids: string[] = [];
      for (const name of matchedNames) {
        const value = attribute.values.find((v) => v.name.toLowerCase() === name.toLowerCase());
        if (!value) continue;
        const gid = await findMetaobjectGidForTaxonomyValue(storeDomain, accessToken, definition.key, value.id, value.name);
        if (gid) gids.push(gid);
      }
      if (gids.length > 0) {
        metafields.push({ namespace: "shopify", key: definition.key, type: definition.type, value: JSON.stringify(gids) });
      }
    }

    await resolveFromRealValues("Size", sizeAttribute, productSizeValues);
    if (hasRealColorValues) {
      await resolveFromRealValues("Color", colorAttribute, productColorValues);
    }

    if (photoAttributes.length === 0) {
      console.log(`[category-metafield-matcher] ${metafields.length} category metafield(s) resolved and ready to set.`);
      return metafields;
    }

    const imageBlocksRaw = await Promise.all(imageUrls.slice(0, 3).map(fetchImageAsBase64Block));
    const imageBlocks = imageBlocksRaw.filter((b): b is ClaudeContentBlock => b !== null);
    if (imageBlocks.length === 0) return metafields;

    const attributesText = photoAttributes
      .map((a) => `${a.name}: [${a.values.map((v) => `"${v.name}"`).join(", ")}]`)
      .join("\n");

    let parsed: { selections: { attributeName: string; chosenValues: string[] }[] } | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const responseText = await callClaude({
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                ...imageBlocks,
                {
                  type: "text",
                  text: `Competitor's original title: ${competitorTitle}\nCompetitor's original description (source text, for factual details like care/fabric — not for copying wording): ${competitorDescription}\n\nAttributes and their allowed candidate values:\n${attributesText}\n\nAnalyze the photos AND the source text above, and select every genuinely applicable value for each attribute.`,
                },
              ],
            },
          ],
          maxTokens: 3000,
        });
        parsed = parseJsonResponse<{ selections: { attributeName: string; chosenValues: string[] }[] }>(responseText);
        break;
      } catch (err) {
        console.error(`[category-metafield-matcher] Attempt ${attempt} failed${attempt === 1 ? ", retrying once" : ""}:`, err);
        if (attempt === 2) {
          // Both attempts failed — return whatever we already resolved
          // (e.g. Size), rather than losing all category metafields over
          // just the photo-based part.
          console.log(`[category-metafield-matcher] ${metafields.length} category metafield(s) resolved and ready to set (photo-based selection failed).`);
          return metafields;
        }
      }
    }
    if (!parsed) return metafields;

    console.log(`[category-metafield-matcher] AI selections:`, parsed.selections);

    for (const selection of parsed.selections) {
      if (!selection.chosenValues || selection.chosenValues.length === 0) continue;

      const attribute = photoAttributes.find((a) => a.name.toLowerCase() === selection.attributeName.toLowerCase());
      if (!attribute) continue;

      const definition = definitions.get(attribute.name.toLowerCase());
      if (!definition) continue;

      const gids: string[] = [];
      for (const chosenValue of selection.chosenValues) {
        // Safety check: the chosen value must exactly match one of the
        // REAL candidates — never trust a value the AI might have
        // invented.
        const matchedValue = attribute.values.find((v) => v.name.toLowerCase() === chosenValue.toLowerCase());
        if (!matchedValue) {
          console.warn(
            `[category-metafield-matcher] AI chose "${chosenValue}" for "${selection.attributeName}", but that's not in the real candidate list — skipped.`
          );
          continue;
        }

        const gid = await findMetaobjectGidForTaxonomyValue(storeDomain, accessToken, definition.key, matchedValue.id, matchedValue.name);
        if (gid) gids.push(gid);
      }

      if (gids.length > 0) {
        metafields.push({
          namespace: "shopify",
          key: definition.key,
          type: definition.type,
          value: JSON.stringify(gids),
        });
      }
    }

    console.log(`[category-metafield-matcher] ${metafields.length} category metafield(s) resolved and ready to set.`);
    return metafields;
  } catch (err) {
    console.error("[category-metafield-matcher] ERROR — skipping category metafields for this product:", err);
    return [];
  }
}

const PRODUCT_METAFIELD_DEFINITIONS_QUERY = `
  query GetAllProductMetafieldDefinitions {
    metafieldDefinitions(ownerType: PRODUCT, first: 100) {
      nodes {
        name
        key
        namespace
        type {
          name
        }
      }
    }
  }
`;

type ProductMetafieldDefinitionsResponse = {
  metafieldDefinitions: {
    nodes: { name: string; key: string; namespace: string; type: { name: string } }[];
  };
};

/**
 * Looks for a custom "Related Products" (or similarly named)
 * collection-reference metafield on this store's product metafield
 * definitions, and — if found — builds a metafield input that points it
 * at the SAME collection already matched for this product (via
 * collection-matcher.ts), so it never needs to be set separately by
 * hand. Returns null if no such field exists on this store, or if no
 * collection was matched for this product in the first place.
 */
export async function findRelatedProductsCollectionMetafield(
  storeDomain: string,
  accessToken: string,
  matchedCollectionId: string | undefined
): Promise<CategoryMetafieldInput | null> {
  if (!matchedCollectionId) return null;

  try {
    const result = await shopifyGraphQL<ProductMetafieldDefinitionsResponse>(
      storeDomain,
      accessToken,
      PRODUCT_METAFIELD_DEFINITIONS_QUERY
    );

    const definition = result.metafieldDefinitions.nodes.find(
      (d) => d.name.toLowerCase().includes("related") && d.type.name.includes("collection_reference")
    );

    if (!definition) {
      console.log(`[category-metafield-matcher] No "Related Products"-style collection-reference metafield found on this store — skipped.`);
      return null;
    }

    console.log(
      `[category-metafield-matcher] Found "${definition.name}" (${definition.namespace}.${definition.key}, ${definition.type.name}) — linking it to the matched collection.`
    );

    const isList = definition.type.name.startsWith("list.");
    return {
      namespace: definition.namespace,
      key: definition.key,
      type: definition.type.name,
      value: isList ? JSON.stringify([matchedCollectionId]) : matchedCollectionId,
    };
  } catch (err) {
    console.error(`[category-metafield-matcher] Related Products metafield lookup failed:`, err);
    return null;
  }
}
