/**
 * Keyword title refiner
 *
 * Simpler approach than the earlier version: instead of building the
 * title from separate, per-attribute chosen building blocks that code
 * then glues together afterward (proved error-prone — duplicate words,
 * compound core nouns split incorrectly, filler words like "Solid
 * Color"), this version has the AI rewrite the FULL title in one go,
 * exactly in the same style as the already-well-working main title —
 * with the sole task of: where a real, high-scoring keyword from the
 * library is exactly as accurate (or more accurate) than the word
 * already in the title, replace that word. The AI therefore reasons
 * about the whole sentence at once, not about separate,
 * mechanically-combined pieces — which largely prevents the earlier
 * class of errors on its own.
 *
 * As of the "occasion" attribute type, the AI also considers the
 * competitor's source title/description text, not just the photos —
 * occasion (e.g. "wedding guest", "cocktail", "party") describes a
 * use-case rather than a visual trait, so it can't be verified from
 * photos alone and needs textual context instead.
 */

import { callClaude, parseJsonResponse, fetchImageAsBase64Block, type ClaudeContentBlock } from "./ai-client";
import { listCategoriesForMarket, getKeywordCandidates } from "./keyword-manager";

/**
 * Simple normalization for category matching: lowercase, spaces/hyphens
 * equalized, trivial plural-s stripped.
 */
function normalizeCategory(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/s$/, "");
}

// Category synonym groups: product types that are effectively the same
// garment but get split across differently-named library categories
// (different English/US spellings, or synonyms the AI picks
// interchangeably). Each group is treated as ONE shared keyword pool, so a
// product tagged with any name in the group sees the combined keywords of
// the whole group instead of just one thin category. Groups below reflect
// the actual German library categories and the store owner's choices
// (coats+jackets together; trousers+pants+chinos together).
const CATEGORY_SYNONYM_GROUPS: string[][] = [
  // Knitwear / pullovers (cardigans deliberately NOT included — different garment)
  ["sweater", "sweaters", "jumper", "jumpers", "pullover", "pullovers", "knitwear", "jersey", "jerseys", "pullunder", "pullunders"],
  // Outerwear — coats + jackets + all coat/jacket subtypes
  ["coat", "coats", "jacket", "jackets", "overcoat", "overcoats", "topcoat", "topcoats",
   "peacoat", "peacoats", "trenchcoat", "trenchcoats", "raincoat", "raincoats",
   "anorak", "anoraks", "windbreaker", "windbreakers", "parka", "parkas", "shacket", "shackets"],
  // Trousers (owner chose to merge trousers + pants + chinos)
  ["trouser", "trousers", "pant", "pants", "chino", "chinos"],
  // Shorts + bermudas (owner's choice)
  ["short", "shorts", "bermuda", "bermudas"],
  // Vests — their own group (owner's choice), separate from knitwear
  ["vest", "vests", "gilet", "gilets", "waistcoat", "waistcoats", "bolero", "boleros", "sweater vest", "sweater vests"],
  // Boots — all boot types share one pool
  ["boot", "boots", "bootie", "booties", "ankle boots", "ankle boot", "knee high boots",
   "knee-high boots", "chelsea boots", "combat boots", "winter boots", "stiefel", "stiefeletten", "winterstiefel"],
  // General everyday shoes (owner chose to merge the flat/heeled types)
  ["shoe", "shoes", "pump", "pumps", "heel", "heels", "flat", "flats", "loafer", "loafers",
   "mule", "mules", "sandal", "sandals", "wedge", "wedges", "ballerina", "ballerinas",
   "clog", "clogs", "espadrille", "espadrilles", "moccasin", "moccasins", "slipper", "slippers"],
  // Smart/formal shoes (own group — distinct search terms)
  ["oxford", "oxfords", "derby", "derbies", "derby shoes", "brogue", "brogues",
   "budapester", "boat shoes", "dress shoes"],
  // Sneakers / trainers
  ["sneaker", "sneakers", "trainer", "trainers"],
  // Pyjamas / sleepwear / robes / loungewear
  ["pyjama", "pyjamas", "pajama", "pajamas", "pyjama sets", "sleepwear", "nightwear",
   "nightgown", "nightgowns", "nightdress", "nightdresses", "robe", "robes", "bathrobe", "bathrobes",
   "loungewear", "lounge set", "lounge sets"],
  // T-shirts (pure spelling split)
  ["t-shirt", "t-shirts", "tshirt", "tshirts"],
  // Polo shirts (three-way split of the same thing)
  ["polo", "polos", "polo shirt", "polo shirts", "poloshirt", "poloshirts"],
  // Hoodies + sweatshirts (casual tops)
  ["hoodie", "hoodies", "sweatshirt", "sweatshirts"],
  // Traditional German wear
  ["dirndl", "dirndls", "tracht", "trachten", "lederhosen", "loferl"],
];

/**
 * Returns all library category names that should share a keyword pool with
 * the given matched category (including itself). If the matched category is
 * part of a synonym group, every category name in that group that actually
 * exists in the library is returned; otherwise just the matched category.
 */
function expandToSynonymCategories(matchedCategory: string, availableCategories: string[]): string[] {
  const normMatched = normalizeCategory(matchedCategory);
  const group = CATEGORY_SYNONYM_GROUPS.find((g) => g.some((name) => normalizeCategory(name) === normMatched));
  if (!group) return [matchedCategory];

  const groupNormalized = new Set(group.map((n) => normalizeCategory(n)));
  const matches = availableCategories.filter((cat) => groupNormalized.has(normalizeCategory(cat)));
  // Always include the matched category itself, even if not in the list.
  if (!matches.some((c) => normalizeCategory(c) === normMatched)) matches.push(matchedCategory);
  return matches;
}

async function findMatchingCategory(market: string, coreProductTypeEnglish: string): Promise<string | null> {
  const availableCategories = await listCategoriesForMarket(market);
  if (availableCategories.length === 0) return null;

  const normalizedTarget = normalizeCategory(coreProductTypeEnglish);
  const directMatch = availableCategories.find((cat) => {
    const normalizedCat = normalizeCategory(cat);
    return normalizedCat === normalizedTarget || normalizedTarget.includes(normalizedCat) || normalizedCat.includes(normalizedTarget);
  });

  return directMatch ?? null;
}

const SYSTEM_PROMPT = `You are refining an already well-written fashion product title to incorporate real, high-value SEO keywords where they genuinely apply — WITHOUT changing its overall style, structure, or quality.

You will be given:
- The product's photos
- The competitor's original product title and description (source text, for context only — never copy its exact wording)
- The CURRENT title (already correctly styled: Title Case, no fabric/material mentioned, natural attribute-rich phrasing, ending on the correct core product noun)
- A list of REAL candidate keywords from a keyword research library for this product category (if available), with real monthly search volume, each labeled with its attribute type

Your ONLY task: check if any word or phrase in the CURRENT title could be replaced with — or, for the "occasion" attribute type only, appended with — a more precise, real, higher-value equivalent term from the candidate list.

CORE PRODUCT NOUN — search-volume upgrade:
The last word(s) of the title are the core product type (e.g. "Schnürstiefel", "Walkjacke", "Rollkragenpullover"). Sometimes this word is accurate but a WEAK search term, while the candidate list contains a word that is still accurate AND much more searched.
- KEY SIGNAL: if the current core product word does NOT appear in the candidate keyword list at all (or only appears very low), that means it has little search volume — it is a weak term. In that case, REPLACE it with the keyword from the list that (a) has high search volume and (b) best and accurately describes this product. (e.g. "Walkjacke" is not in the list → replace with an accurate high-volume word from the list such as "Wolljacke", "Jacke", or "Mantel" — whichever fits the product; "Kniehohe Schnürstiefel" → "Kniehohe Stiefel".) Pick the highest-volume candidate that still truthfully describes the product — do not pick a high-volume word that describes a different product.
- If the current core product word IS already in the list with a strong, high volume (e.g. "Rollkragenpullover", "Maxikleid", "Trenchcoat", "Steppjacke"), keep it — do not change it.
- NEVER remove or weaken the distinctive attributes around it. "Kniehohe", "Maxi", "Oversized", "Gefüttert", "Taillierter Schnitt" etc. must stay. You only swap the product-type WORD itself, never drop the descriptive attributes.
- NEVER broaden to a meaningless catch-all ("Schuhe", "Kleid", "Oberteil", "Damenmode"), and never pick a word for a genuinely different product type just because it has volume (e.g. don't call a blazer a "Winterjacke").

How to judge a candidate, depending on its attribute type:
- For VISUAL attribute types (material excluded — pattern, silhouette, closure_style, neckline, sleeve_length, heel_style, toe_style, fit): only use a candidate if it's 100% accurate to what's visible in the PHOTOS.
- For "occasion" candidates (e.g. "wedding guest", "cocktail", "party", "work", "summer"): these describe a use-case, not a visual trait, so you can't verify them from photos alone. Base this judgment on the competitor's title/description text — only use an occasion candidate if the source text genuinely supports it (e.g. it's described as suitable for that occasion, or its styling — described or shown — clearly matches the mood/formality of that occasion). If the source text gives no real signal either way, don't add an occasion term.
- In all cases, a substitution must read at least as naturally as the original. If a candidate keyword would make the title inaccurate, redundant, or awkward, don't use it.

TERMINOLOGY (applies to any substitution you make):
- Never introduce the word "Orthopedic" into the title.
- If a substitution involves a leather-look material, phrase it as "Vegan Leather" — never "Leather", "Faux Leather", or "Faux-Leather".

RULES:
- Never invent a candidate that isn't in the provided list.
- Never make the title less accurate than it currently is.
- Never add fabric/material words.
- Never duplicate a word that's already part of the core product noun at the end of the title.
- Add at most one occasion term, and only when the source text genuinely supports it — when in doubt, leave it out.
- If nothing in the library genuinely improves the current title, return it completely unchanged.
- Keep the exact same Title Case style and overall structure — you're refining word choices, not rewriting the whole title.

Respond with ONLY valid JSON, no markdown, no preamble:
{ "refinedTitleSuffix": string }`;

export type BuiltTitleResult = {
  titleSuffix: string;
} | null;

/**
 * Attempts to refine the already-generated title with real, high-scoring
 * keywords from the library — if available and accurate. Returns null on
 * a technical error or if there are no usable images; the caller then
 * simply keeps the original title.
 */
export async function tryKeywordOptimizedTitle(
  market: string,
  coreProductTypeEnglish: string,
  gender: string,
  imageUrls: string[],
  currentTitleSuffix: string,
  competitorTitle: string,
  competitorDescription: string
): Promise<BuiltTitleResult> {
  const matchedCategory = await findMatchingCategory(market, coreProductTypeEnglish);
  console.log(`[keyword-title-optimizer] Recognized category "${coreProductTypeEnglish}" -> library category:`, matchedCategory);

  let candidatesText = "No library data available for this category — return the title unchanged.";
  if (matchedCategory) {
    // Pull keywords from every category in this one's synonym group (e.g.
    // "sweaters" + "jumpers"), so a pullover tagged either way sees the
    // full shared pool instead of just one thin category.
    const availableCategories = await listCategoriesForMarket(market);
    const synonymCategories = expandToSynonymCategories(matchedCategory, availableCategories);
    if (synonymCategories.length > 1) {
      console.log(
        `[keyword-title-optimizer] Category "${matchedCategory}" grouped with: ${synonymCategories.join(", ")}`
      );
    }

    const candidateArrays = await Promise.all(
      synonymCategories.map((cat) => getKeywordCandidates(market, cat))
    );
    // Flatten + de-duplicate by keyword (keep the highest volume seen).
    const byKeyword = new Map<string, (typeof candidateArrays)[0][0]>();
    for (const arr of candidateArrays) {
      for (const c of arr) {
        const existing = byKeyword.get(c.keyword.toLowerCase());
        if (!existing || c.searchVolume > existing.searchVolume) {
          byKeyword.set(c.keyword.toLowerCase(), c);
        }
      }
    }
    const candidates = [...byKeyword.values()];

    const BLOCKED_TERMS = /orthopedic|leather/i;
    const usableCandidates = candidates.filter(
      (c) => c.attributeSlot !== "material" && !BLOCKED_TERMS.test(c.keyword)
    );
    console.log(
      `[keyword-title-optimizer] ${usableCandidates.length} usable candidate keywords found for "${matchedCategory}" (${market})`
    );
    if (usableCandidates.length > 0) {
      // Only send the top 40 keywords by search volume to the AI. Sending
      // the full list (which can be 200-300 for big categories like
      // jackets/coats) made the prompt so large that the refinement call
      // sometimes returned no usable response at all ("Claude returned no
      // text response"), so the title was left un-refined. The highest-
      // volume keywords are what matter for the title anyway; the long
      // tail adds little and was causing the failures.
      const TOP_N = 25;
      const topCandidates = usableCandidates
        .sort((a, b) => b.searchVolume - a.searchVolume)
        .slice(0, TOP_N);

      console.log(
        `[keyword-title-optimizer] Using top ${topCandidates.length} of ${usableCandidates.length} keywords (by volume) for "${matchedCategory}":`,
        topCandidates.map((c) => `${c.keyword} (${c.searchVolume})`).join(", ")
      );

      candidatesText = topCandidates
        .map((c) => `- "${c.keyword}" (${c.attributeSlot}, volume: ${c.searchVolume})`)
        .join("\n");
    }
  }

  const imageBlocksRaw = await Promise.all(imageUrls.slice(0, 3).map(fetchImageAsBase64Block));
  const imageBlocks = imageBlocksRaw.filter((b): b is ClaudeContentBlock => b !== null);

  if (imageBlocks.length === 0) return null;

  // Run the refinement, with one automatic retry. The refinement call
  // occasionally fails with "no text response" or a truncated/unparseable
  // JSON — usually a transient issue, more common on the big merged
  // categories (jackets/coats have hundreds of keywords). A single clean
  // retry recovers most of these instead of silently skipping the keyword
  // step. If both attempts fail, we keep the original (un-refined) title.
  async function attemptRefinement(): Promise<BuiltTitleResult> {
    const responseText = await callClaude({
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `Gender: ${gender}\nCompetitor's original title: ${competitorTitle}\nCompetitor's original description (source, for context only — do not copy wording): ${competitorDescription}\nCurrent title: "${currentTitleSuffix}"\n\nCandidate keywords from library (sorted by volume):\n${candidatesText}\n\nLook at the photos AND the competitor's text above, and refine the title only where that's a genuine, accurate improvement. Keep the exact same language as the current title.`,
            },
          ],
        },
      ],
      maxTokens: 2000,
    });

    const parsed = parseJsonResponse<{ refinedTitleSuffix: string }>(responseText);
    console.log(`[keyword-title-optimizer] Title before refinement: "${currentTitleSuffix}"`);
    console.log(`[keyword-title-optimizer] Title after refinement:  "${parsed.refinedTitleSuffix}"`);

    if (!parsed.refinedTitleSuffix || parsed.refinedTitleSuffix.trim().length === 0) {
      return null;
    }
    return { titleSuffix: parsed.refinedTitleSuffix.trim() };
  }

  // Up to 3 attempts. The refinement call can intermittently return no
  // text or truncated JSON, more often on the big merged categories
  // (coats has 300+ keywords). A short pause between tries lets a
  // transient issue clear. If all fail, keep the original title (the
  // main generation already applied the important product-type wording,
  // so this step is an enhancement, not a requirement).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptRefinement();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[keyword-title-optimizer] Refinement attempt ${attempt}/${MAX_ATTEMPTS} failed (${msg}) — retrying.`);
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      } else {
        console.error(`[keyword-title-optimizer] All ${MAX_ATTEMPTS} attempts failed, keeping original title:`, msg);
        return null;
      }
    }
  }
  return null;
}
