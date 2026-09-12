/**
 * Variant translator
 *
 * Translates option names (e.g. "Color" -> "Colour") and descriptive
 * option values (e.g. "Gray" -> "Grey") to the chosen language variant.
 * Standard size codes (S/M/L/XL, numeric sizes like 36/37/38) are left
 * unchanged — these are internationally standard and aren't translated in
 * practice.
 */

import { callClaude, parseJsonResponse } from "./ai-client";
import { SUPPORTED_LANGUAGES, type LanguageCode } from "./languages";
import type { ShopifyProductRaw } from "./scraper";

export type TranslatedOptions = {
  optionNames: Record<string, string>; // "Color" -> "Colour"
  optionValues: Record<string, string>; // "Color:Gray" -> "Grey"
};

function buildSystemPrompt(languageName: string): string {
  return `You are a professional translator/localizer for fashion e-commerce product options. Convert the given option names and values from their source spelling into natural, correct ${languageName}.

Rules:
- Convert option NAMES (e.g. "Color" -> the natural ${languageName} word for "Color" — for British English this is "Colour", for American English this stays "Color"; "Size" -> the natural ${languageName} word for "Size").
- Convert descriptive option VALUES (like color names: Black, Red, Navy/Grey vs Gray, or material names) into natural, correct ${languageName} fashion retail terminology and spelling conventions.
- Even when the target language is English (American or British), still apply correct regional spelling — e.g. "Gray" <-> "Grey", "Color" <-> "Colour", "Personalize" <-> "Personalise" — never assume the source spelling already matches the target.
- Do NOT translate standard size codes used internationally as-is (S, M, L, XL, XXL, 2XL, 3XL, or numeric sizes like 36, 37, UK 8, EU 40, etc.) — keep these exactly as given.
- If a value is a full descriptive size word (e.g. "Small", "Medium", "Large", "One Size"), DO convert it naturally.
- Keep results concise and natural, matching normal fashion retail conventions in ${languageName}.

Respond with ONLY valid JSON, no markdown, no preamble:
{
  "options": [
    { "originalName": string, "translatedName": string, "values": [ { "original": string, "translated": string } ] }
  ]
}`;
}

function identityMapping(options: ShopifyProductRaw["options"]): TranslatedOptions {
  const optionNames: Record<string, string> = {};
  const optionValues: Record<string, string> = {};
  for (const opt of options) {
    optionNames[opt.name] = opt.name;
    for (const v of opt.values) {
      optionValues[`${opt.name}:${v}`] = v;
    }
  }
  return { optionNames, optionValues };
}

export async function translateVariantOptions(
  options: ShopifyProductRaw["options"],
  language: LanguageCode
): Promise<TranslatedOptions> {
  if (options.length === 0) {
    return { optionNames: {}, optionValues: {} };
  }

  try {
    const responseText = await callClaude({
      system: buildSystemPrompt(SUPPORTED_LANGUAGES[language]),
      messages: [
        {
          role: "user",
          content: `Options:\n${options.map((o) => `${o.name}: ${o.values.join(", ")}`).join("\n")}`,
        },
      ],
      maxTokens: 800,
    });

    const parsed = parseJsonResponse<{
      options: {
        originalName: string;
        translatedName: string;
        values: { original: string; translated: string }[];
      }[];
    }>(responseText);

    const optionNames: Record<string, string> = {};
    const optionValues: Record<string, string> = {};
    for (const opt of parsed.options) {
      optionNames[opt.originalName] = opt.translatedName;
      for (const v of opt.values) {
        optionValues[`${opt.originalName}:${v.original}`] = v.translated;
      }
    }
    return { optionNames, optionValues };
  } catch {
    // On error: keep the original (English) instead of failing the whole
    // import over this one part.
    return identityMapping(options);
  }
}
