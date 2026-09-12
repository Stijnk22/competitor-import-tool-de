/**
 * Scraper module
 *
 * Every Shopify store has a publicly accessible JSON endpoint per product:
 *   https://{store}.com/products/{handle}.json
 * This returns all raw product data (title, description, variants, price,
 * images in order) without authentication.
 *
 * This module normalizes a user-pasted product URL to the correct .json
 * endpoint, fetches the data, and validates that it does indeed look like
 * a Shopify product.
 */

export type ShopifyImage = {
  id: number;
  position: number;
  src: string;
  width: number;
  height: number;
  variant_ids: number[];
};

export type ShopifyVariant = {
  id: number;
  title: string;
  price: string;
  sku: string;
  position: number;
  option1: string | null; // usually color
  option2: string | null; // usually size
  option3: string | null;
  available: boolean;
  featured_image: ShopifyImage | null;
};

export type ShopifyProductRaw = {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  handle: string;
  tags: string; // Shopify returns this as a comma-separated string, e.g. "heels, lace, wedding"
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  options: { name: string; position: number; values: string[] }[];
};

export type ScrapeResult =
  | { success: true; sourceUrl: string; product: ShopifyProductRaw }
  | { success: false; sourceUrl: string; reason: string };

/**
 * Normalizes a pasted product URL (with or without trailing slash, query
 * params, .json already present) to the correct .json endpoint.
 */
function buildJsonUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  // strip any query params and hash, we only want the path
  url.search = "";
  url.hash = "";

  let pathname = url.pathname.replace(/\/+$/, ""); // remove trailing slash
  if (!pathname.endsWith(".json")) {
    pathname = `${pathname}.json`;
  }

  return `${url.protocol}//${url.host}${pathname}`;
}

export async function scrapeCompetitorProduct(
  sourceUrl: string
): Promise<ScrapeResult> {
  let jsonUrl: string;
  try {
    jsonUrl = buildJsonUrl(sourceUrl);
  } catch {
    return {
      success: false,
      sourceUrl,
      reason: "Invalid URL — could not be parsed.",
    };
  }

  let response: Response;
  try {
    response = await fetch(jsonUrl, {
      headers: { Accept: "application/json" },
      // prevents a slow/hanging competitor store from blocking the whole batch
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      success: false,
      sourceUrl,
      reason: `Could not reach the page (${(err as Error).message}).`,
    };
  }

  if (response.status === 404) {
    return {
      success: false,
      sourceUrl,
      reason: "Product not found (404) — no longer exists or the URL is incorrect.",
    };
  }

  if (!response.ok) {
    return {
      success: false,
      sourceUrl,
      reason: `Unexpected server error (HTTP ${response.status}).`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      success: false,
      sourceUrl,
      reason: "Response is not valid JSON — this doesn't look like a Shopify store.",
    };
  }

  const product = (data as { product?: ShopifyProductRaw })?.product;
  if (!product || !product.title || !Array.isArray(product.variants)) {
    return {
      success: false,
      sourceUrl,
      reason: "No valid Shopify product data found at this endpoint.",
    };
  }

  return { success: true, sourceUrl, product };
}
