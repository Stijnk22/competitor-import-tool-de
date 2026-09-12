/**
 * Claude API client
 *
 * Thin wrapper around the Anthropic Messages API. Used for:
 *  - Recognizing product attributes from images (vision)
 *  - Generating title/description/meta content according to our fixed template
 *
 * Model is configurable via ANTHROPIC_MODEL (env), with a sensible default.
 */

const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL_OVERRIDE || "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export class ClaudeAPIError extends Error {}

export async function callClaude(params: {
  system: string;
  messages: { role: "user" | "assistant"; content: ClaudeContentBlock[] | string }[];
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeAPIError(
      "ANTHROPIC_API_KEY is missing. Set it in .env.local (locally) or in the environment variables (Railway)."
    );
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: params.maxTokens ?? 2500,
      system: params.system,
      messages: params.messages,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new ClaudeAPIError(`Anthropic API returned HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json();
  const textBlock = (json.content as { type: string; text?: string }[] | undefined)?.find(
    (b) => b.type === "text"
  );

  if (!textBlock?.text) {
    throw new ClaudeAPIError("Claude returned no text response.");
  }

  return textBlock.text;
}

/**
 * Claude usually sticks to "JSON only", but to be safe we strip any
 * ```json code fences before parsing.
 */
export function parseJsonResponse<T>(text: string): T {
  const cleaned = text.replace(/```json\s*|```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Show both the start and end of the response: if the end breaks off
    // mid-word/mid-value (instead of cleanly on "}"), that points to
    // truncation from the token budget — that distinction is exactly what
    // we need to quickly diagnose this kind of error in the future.
    const preview =
      cleaned.length > 400
        ? `${cleaned.slice(0, 200)} ... [${cleaned.length} characters total] ... ${cleaned.slice(-200)}`
        : cleaned;
    throw new ClaudeAPIError(`Could not parse Claude's response as JSON. Received: ${preview}`);
  }
}

/**
 * Downloads an image and converts it to a base64 block for the vision API.
 * Returns null on error, so one broken image doesn't block the entire
 * content generation.
 */
export async function fetchImageAsBase64Block(url: string): Promise<ClaudeContentBlock | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return {
      type: "image",
      source: { type: "base64", media_type: contentType, data: base64 },
    };
  } catch {
    return null;
  }
}
