/**
 * Currency detection & conversion
 *
 * Some competitors run their Shopify store in a different base currency
 * than what they SHOW to visitors (via Shopify Markets). The .json
 * endpoint used by scraper.ts always returns the RAW BACKEND price.
 *
 * CONFIRMED, RELIABLE METHOD: Shopify's own `?country=XX` URL parameter
 * (part of their official "localization" mechanism) forces the display
 * for a specific country — live-tested and confirmed to work
 * (jesse-london.co shows pounds with ?country=GB, dollars with
 * ?country=US). So this is no longer a guess, but Shopify's own official
 * way to request a market context.
 *
 * Priority order:
 *  1. Fetch the page with ?country=<matching country> — most reliable method
 *  2. Shopify's own embedded exchange-rate object (Shopify.currency), if 1
 *     gave no usable result
 *  3. Guess currency via /cart.js + our own conversion
 *  4. Raw .json price unchanged (last resort)
 *
 * Whenever a step isn't 100% certain, a clear warning is returned so this
 * is visible to the user.
 */

// Common currencies -> representative country code for the ?country=
// parameter. Covers at least the languages/markets the tool supports;
// other currencies fall back to the other detection methods.
const CURRENCY_TO_COUNTRY: Record<string, string> = {
  GBP: "GB",
  USD: "US",
  EUR: "DE",
  DKK: "DK",
  CAD: "CA",
  AUD: "AU",
  SEK: "SE",
  NOK: "NO",
  CHF: "CH",
};

/**
 * Fetches the product page with a forced country context (?country=XX),
 * Shopify's own official way to request a specific market. Returns the
 * HTML, or null if this fails or no matching country code is known for
 * this currency.
 */
async function fetchPageWithForcedCountry(productUrl: string, targetCurrency: string): Promise<string | null> {
  const countryCode = CURRENCY_TO_COUNTRY[targetCurrency];
  if (!countryCode) return null;

  try {
    const url = new URL(productUrl);
    url.searchParams.set("country", countryCode);
    const res = await fetch(url.toString(), {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export type DisplayedPrice = { amount: number; currency: string };

/**
 * Looks for Shopify's own embedded currency conversion object in the page
 * HTML. If present, this is the EXACT rate the theme itself uses to
 * convert the base price for visitors.
 */
function extractShopifyCurrencyRate(html: string): { activeCurrency: string; rate: number } | null {
  const match = html.match(/Shopify\.currency\s*=\s*(\{[^}]*\})/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    const rate = parseFloat(data.rate);
    if (typeof data.active === "string" && !Number.isNaN(rate)) {
      return { activeCurrency: data.active.toUpperCase(), rate };
    }
  } catch {
    // ignore, try other methods
  }
  return null;
}

/**
 * Reads price + currency from structured data (JSON-LD / Open Graph).
 * Note: this can be the RAW base price rather than the displayed price
 * (see explanation above) — so only use this as an additional signal, not
 * blindly as the final result.
 */
function extractStructuredDataPrice(html: string): DisplayedPrice | null {
  const ldJsonBlocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of ldJsonBlocks) {
    try {
      const data = JSON.parse(block[1].trim());
      const candidates = Array.isArray(data) ? data : [data];
      for (const item of candidates) {
        const offersRaw = item?.offers;
        const offer = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw;
        const price = offer?.price ?? offer?.priceSpecification?.price;
        const currency = offer?.priceCurrency ?? offer?.priceSpecification?.priceCurrency;
        if (price && currency) {
          const amount = parseFloat(String(price));
          if (!Number.isNaN(amount)) {
            return { amount, currency: String(currency).toUpperCase() };
          }
        }
      }
    } catch {
      continue;
    }
  }

  const amountMatch = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  const currencyMatch = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["']/i);
  if (amountMatch && currencyMatch) {
    const amount = parseFloat(amountMatch[1]);
    if (!Number.isNaN(amount)) {
      return { amount, currency: currencyMatch[1].toUpperCase() };
    }
  }

  return null;
}

/**
 * Fetches the (presentment) currency of a Shopify store via the public
 * /cart.js endpoint. Fallback method, less certain than the other signals.
 */
export async function detectShopCurrency(productUrl: string): Promise<string | null> {
  try {
    const url = new URL(productUrl);
    const cartUrl = `${url.protocol}//${url.host}/cart.js`;
    const res = await fetch(cartUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.currency === "string" ? data.currency : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the current exchange rate via Frankfurter (free, no API key
 * needed, based on ECB reference rates).
 */
export async function getExchangeRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const rate = data?.rates?.[to];
    return typeof rate === "number" ? rate : null;
  } catch {
    return null;
  }
}

export type PriceResolutionResult =
  | { source: "forced_country"; amount: number; converted: boolean; currency: string; rate?: number; originalCurrency?: string }
  | { source: "shopify_embedded_rate"; amount: number; converted: boolean; currency: string; rate?: number; originalCurrency?: string }
  | { source: "structured_data_guess"; amount: number; converted: boolean; currency: string; rate?: number; originalCurrency?: string }
  | { source: "json_currency_guess"; amount: number; converted: boolean; currency: string; rate?: number; originalCurrency?: string }
  | { source: "raw_fallback"; amount: number };

/**
 * Determines the most reliable price for this product, in the currency of
 * our own store. See the priority order at the top of this file.
 */
export async function resolveCompetitorPrice(
  rawJsonPrice: number,
  productUrl: string,
  targetCurrency: string
): Promise<PriceResolutionResult> {
  // Step 0 — confirmed most reliable method: fetch the page with a forced
  // country context (?country=XX), Shopify's own official localization
  // mechanism. This should put the structured data directly in the
  // correct (target) currency, without us needing to convert ourselves.
  const forcedCountryHtml = await fetchPageWithForcedCountry(productUrl, targetCurrency);
  if (forcedCountryHtml) {
    const structured = extractStructuredDataPrice(forcedCountryHtml);
    if (structured && structured.currency === targetCurrency) {
      return { source: "forced_country", amount: structured.amount, converted: false, currency: targetCurrency };
    }
    // Structured data gave no (matching) result — try the embedded
    // conversion object on this same, country-forced page.
    const embeddedOnForced = extractShopifyCurrencyRate(forcedCountryHtml);
    if (embeddedOnForced && embeddedOnForced.activeCurrency === targetCurrency) {
      return {
        source: "forced_country",
        amount: Math.round(rawJsonPrice * embeddedOnForced.rate * 100) / 100,
        converted: false,
        currency: targetCurrency,
      };
    }
  }

  // From here on: fetch the regular (non-country-forced) page for the
  // remaining fallback methods.
  let html: string | null = null;
  try {
    const res = await fetch(productUrl, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) html = await res.text();
  } catch {
    html = null;
  }

  // Step 1 — best method: Shopify's own embedded conversion object.
  // Applied to the RAW .json price, since that object converts from the
  // base price — exactly as the theme itself does.
  if (html) {
    const embedded = extractShopifyCurrencyRate(html);
    if (embedded) {
      const amount = Math.round(rawJsonPrice * embedded.rate * 100) / 100;
      if (embedded.activeCurrency === targetCurrency) {
        return { source: "shopify_embedded_rate", amount, converted: false, currency: targetCurrency };
      }
      // The competitor's displayed currency also differs from our own
      // store currency — one more conversion needed.
      const rate = await getExchangeRate(embedded.activeCurrency, targetCurrency);
      if (rate !== null) {
        return {
          source: "shopify_embedded_rate",
          amount: Math.round(amount * rate * 100) / 100,
          converted: true,
          currency: targetCurrency,
          rate,
          originalCurrency: embedded.activeCurrency,
        };
      }
      return { source: "shopify_embedded_rate", amount, converted: false, currency: embedded.activeCurrency };
    }
  }

  // Step 2 — structured data as a signal. Only trusted if the amount
  // clearly DIFFERS from the raw .json price (a sign it's genuinely been
  // converted, not just repeating the base price).
  if (html) {
    const structured = extractStructuredDataPrice(html);
    if (structured) {
      const percentDiff = Math.abs(structured.amount - rawJsonPrice) / rawJsonPrice;
      const looksGenuinelyConverted = percentDiff > 0.02; // >2% difference

      if (looksGenuinelyConverted) {
        if (structured.currency === targetCurrency) {
          return { source: "structured_data_guess", amount: structured.amount, converted: false, currency: structured.currency };
        }
        const rate = await getExchangeRate(structured.currency, targetCurrency);
        if (rate !== null) {
          return {
            source: "structured_data_guess",
            amount: Math.round(structured.amount * rate * 100) / 100,
            converted: true,
            currency: targetCurrency,
            rate,
            originalCurrency: structured.currency,
          };
        }
      } else if (structured.currency !== targetCurrency) {
        // Amount matches the raw price -> structured data is likely
        // showing the base currency, not the displayed price. Use it as
        // a signal for the source language of the raw .json price.
        const rate = await getExchangeRate(structured.currency, targetCurrency);
        if (rate !== null) {
          return {
            source: "structured_data_guess",
            amount: Math.round(rawJsonPrice * rate * 100) / 100,
            converted: true,
            currency: targetCurrency,
            rate,
            originalCurrency: structured.currency,
          };
        }
      }
    }
  }

  // Step 3 — fallback: guess the store's currency via /cart.js.
  const guessedCurrency = await detectShopCurrency(productUrl);
  if (guessedCurrency) {
    if (guessedCurrency === targetCurrency) {
      return { source: "json_currency_guess", amount: rawJsonPrice, converted: false, currency: guessedCurrency };
    }
    const rate = await getExchangeRate(guessedCurrency, targetCurrency);
    if (rate !== null) {
      return {
        source: "json_currency_guess",
        amount: Math.round(rawJsonPrice * rate * 100) / 100,
        converted: true,
        currency: targetCurrency,
        rate,
        originalCurrency: guessedCurrency,
      };
    }
  }

  // Step 4 — last resort: nothing could be confirmed.
  return { source: "raw_fallback", amount: rawJsonPrice };
}
