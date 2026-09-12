/**
 * Converts a title part into a Shopify-friendly URL slug.
 * e.g. "Women's Floral Lace Peep-Toe Stiletto Ankle-Strap Heels"
 *  -> "womens-floral-lace-peep-toe-stiletto-ankle-strap-heels"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/'/g, "") // strip apostrophes (women's -> womens)
    .replace(/[^a-z0-9]+/g, "-") // anything that isn't a letter/digit becomes a hyphen
    .replace(/^-+|-+$/g, ""); // strip leading/trailing hyphens
}
