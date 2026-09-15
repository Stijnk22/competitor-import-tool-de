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
    let contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());

    // The Anthropic API rejects images over ~5 MB (base64 inflates raw
    // bytes by ~33%, and the hard limit is 10 MB of base64). Large source
    // photos — more common now that we send up to 8 per product — would
    // otherwise make the whole request fail with a 400. So if the raw
    // image is big, downscale + re-encode it as JPEG with sharp until it's
    // comfortably under the limit. This also strips metadata as a bonus.
    // sharp is loaded lazily so this file has no hard dependency on it
    // unless a large image is actually encountered.
    const RAW_LIMIT_BYTES = 4_500_000; // keep base64 safely under 10 MB
    let finalBuffer = buffer;
    if (buffer.byteLength > RAW_LIMIT_BYTES) {
      try {
        const sharpModule = (await import("sharp")).default;
        // Cap the longest side at 1600px and compress; retry smaller if
        // still too large. 1600px is plenty for attribute recognition.
        let width = 1600;
        let out = await sharpModule(buffer).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
        while (out.byteLength > RAW_LIMIT_BYTES && width > 600) {
          width = Math.floor(width * 0.75);
          out = await sharpModule(buffer).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
        }
        finalBuffer = out;
        contentType = "image/jpeg";
      } catch (err) {
        // If sharp fails for any reason, skip this image rather than
        // sending an oversized one that would fail the whole request.
        console.warn(`[ai-client] Could not downscale large image (${buffer.byteLength} bytes), skipping it:`, err);
        return null;
      }
    }

    const base64 = finalBuffer.toString("base64");
    return {
      type: "image",
      source: { type: "base64", media_type: contentType, data: base64 },
    };
  } catch {
    return null;
  }
}
