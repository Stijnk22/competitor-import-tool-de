/**
 * Size chart extractor
 *
 * Competitor product pages sometimes include a size chart directly inside
 * their description HTML — either as an actual <table> with measurements,
 * or as an <img> (e.g. a size-guide graphic). This module looks for either
 * one in the raw, scraped body_html and returns clean, reusable HTML to
 * append to our own generated description.
 *
 * This is factual, structural data (measurements), not creative copy — so
 * reusing it directly is fine and doesn't conflict with the "never copy
 * the competitor's wording" rule that applies to descriptive prose.
 *
 * Best-effort only: if no size chart can be found, this returns null and
 * the import proceeds normally without one.
 */

/**
 * Strips all HTML attributes from a fragment (style, class, id, width,
 * etc.), keeping only the tag structure and text content. This makes a
 * copied table inherit the destination store's own theme styling cleanly,
 * instead of carrying over the competitor's (often clashing) inline
 * styles.
 */
function stripAttributes(html: string): string {
  return html.replace(/<(\/?[a-zA-Z0-9]+)(\s[^>]*)?>/g, "<$1>");
}

/**
 * Looks for a <table> in the HTML that looks like a size chart (contains
 * common sizing terms like "size", "chest", "waist", "bust", "hip", "cm",
 * "inch" in its text) rather than just any incidental table.
 */
function extractSizeTable(html: string): string | null {
  const tableMatches = html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi);
  const SIZE_INDICATORS = /size|chest|waist|bust|hip|inch|cm\b|measurement/i;

  for (const match of tableMatches) {
    const tableHtml = match[0];
    const plainText = tableHtml.replace(/<[^>]+>/g, " ");
    if (SIZE_INDICATORS.test(plainText)) {
      return stripAttributes(tableHtml);
    }
  }
  return null;
}

/**
 * Looks for an <img> whose alt text or filename suggests it's a size
 * chart/guide graphic.
 */
function extractSizeImage(html: string): string | null {
  const imgMatches = html.matchAll(/<img[^>]*>/gi);
  const SIZE_INDICATORS = /size[\s-]?(chart|guide)|sizing|measurement/i;

  for (const match of imgMatches) {
    const imgTag = match[0];
    if (SIZE_INDICATORS.test(imgTag)) {
      const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
      const altMatch = imgTag.match(/alt=["']([^"']*)["']/i);
      if (srcMatch) {
        const src = srcMatch[1].startsWith("//") ? `https:${srcMatch[1]}` : srcMatch[1];
        const alt = altMatch?.[1] || "Size chart";
        return `<img src="${src}" alt="${alt}" style="max-width: 100%; height: auto;" />`;
      }
    }
  }
  return null;
}

/**
 * Extracts a size chart from the competitor's raw description HTML, if
 * one can be found, wrapped with a "Size Chart" heading matching the
 * style of the rest of our generated description. Returns null if no
 * size chart is found — this is a best-effort addition, never a hard
 * requirement.
 */
export function extractSizeChart(competitorBodyHtml: string): string | null {
  const table = extractSizeTable(competitorBodyHtml);
  if (table) {
    return `<p><strong>Size Chart</strong></p>${table}`;
  }

  const image = extractSizeImage(competitorBodyHtml);
  if (image) {
    return `<p><strong>Size Chart</strong></p>${image}`;
  }

  return null;
}
