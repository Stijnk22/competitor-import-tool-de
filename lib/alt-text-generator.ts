/**
 * Alt text generator
 *
 * Generates SEO-optimized alt text for each product image, based on what's
 * actually visible in the image, in the chosen target language. One
 * Claude call per product (all images at once) instead of one call per
 * image — faster and cheaper, while preserving the correct order.
 */

import { callClaude, parseJsonResponse, fetchImageAsBase64Block, type ClaudeContentBlock } from "./ai-client";
import { SUPPORTED_LANGUAGES, type LanguageCode } from "./languages";

function buildSystemPrompt(languageName: string): string {
  return `You are an SEO specialist writing alt text for product images on a fashion e-commerce site, optimized for Google Images and Google Shopping ranking. Write the alt text entirely in ${languageName}.

For each image provided, write one concise, descriptive alt text (8-15 words) that:
- Describes what is visually shown (garment/item, color, key visual details)
- Naturally includes the core product type and 1-2 key attributes (never keyword-stuffed)
- Never starts with the local equivalent of "Image of" or "Photo of"
- Is a natural, descriptive phrase in ${languageName}, not a full sentence

Respond with ONLY a valid JSON object, no markdown, no preamble:
{ "altTexts": ["...", "...", ...] }
The array must have exactly one entry per image, in the same order the images were provided.`;
}

/**
 * Generates alt texts for a list of image URLs, in the same order, in the
 * chosen language. If an image can't be downloaded, or if the AI call
 * fails entirely, the tool falls back to a generic but usable alt text so
 * the import never gets stuck.
 */
export async function generateAltTexts(
  imageUrls: string[],
  productTitle: string,
  language: LanguageCode
): Promise<string[]> {
  const fallback = imageUrls.map((_, i) => `${productTitle} - image ${i + 1}`);
  if (imageUrls.length === 0) return [];

  const imageBlocksRaw = await Promise.all(imageUrls.map(fetchImageAsBase64Block));
  const validIndices: number[] = [];
  const imageBlocks: ClaudeContentBlock[] = [];
  imageBlocksRaw.forEach((block, i) => {
    if (block) {
      imageBlocks.push(block);
      validIndices.push(i);
    }
  });

  if (imageBlocks.length === 0) return fallback;

  try {
    const responseText = await callClaude({
      system: buildSystemPrompt(SUPPORTED_LANGUAGES[language]),
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `Product: ${productTitle}\n\nGenerate alt text for each of the ${imageBlocks.length} images above, in the same order, entirely in ${SUPPORTED_LANGUAGES[language]}.`,
            },
          ],
        },
      ],
      maxTokens: 800,
    });

    const parsed = parseJsonResponse<{ altTexts: string[] }>(responseText);

    const result = [...fallback];
    validIndices.forEach((originalIndex, j) => {
      if (parsed.altTexts[j]) {
        result[originalIndex] = parsed.altTexts[j];
      }
    });
    return result;
  } catch {
    // Alt text is important for SEO but not critical enough to fail the
    // whole import — on error here we use the fallback.
    return fallback;
  }
}
