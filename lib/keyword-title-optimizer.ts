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
    const candidates = await getKeywordCandidates(market, matchedCategory);
    const BLOCKED_TERMS = /orthopedic|leather/i;
    const usableCandidates = candidates.filter(
      (c) => c.attributeSlot !== "material" && !BLOCKED_TERMS.test(c.keyword)
    );
    console.log(
      `[keyword-title-optimizer] ${usableCandidates.length} usable candidate keywords found for "${matchedCategory}" (${market})`
    );
    if (usableCandidates.length > 0) {
      candidatesText = usableCandidates
        .sort((a, b) => b.searchVolume - a.searchVolume)
        .map((c) => `- "${c.keyword}" (${c.attributeSlot}, volume: ${c.searchVolume})`)
        .join("\n");
    }
  }

  const imageBlocksRaw = await Promise.all(imageUrls.slice(0, 3).map(fetchImageAsBase64Block));
  const imageBlocks = imageBlocksRaw.filter((b): b is ClaudeContentBlock => b !== null);

  if (imageBlocks.length === 0) return null;

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
              text: `Gender: ${gender}\nCompetitor's original title: ${competitorTitle}\nCompetitor's original description (source, for context only — do not copy wording): ${competitorDescription}\nCurrent title: "${currentTitleSuffix}"\n\nCandidate keywords from library (sorted by volume):\n${candidatesText}\n\nLook at the photos AND the competitor's text above, and refine the title only where that's a genuine, accurate improvement. Keep the exact same language as the current title.`,
            },
          ],
        },
      ],
      maxTokens: 500,
    });

    const parsed = parseJsonResponse<{ refinedTitleSuffix: string }>(responseText);
    console.log(`[keyword-title-optimizer] Title before refinement: "${currentTitleSuffix}"`);
    console.log(`[keyword-title-optimizer] Title after refinement:  "${parsed.refinedTitleSuffix}"`);

    if (!parsed.refinedTitleSuffix || parsed.refinedTitleSuffix.trim().length === 0) {
      return null;
    }

    return { titleSuffix: parsed.refinedTitleSuffix.trim() };
  } catch (err) {
    console.error(`[keyword-title-optimizer] Error, keeping original title:`, err);
    return null;
  }
}
