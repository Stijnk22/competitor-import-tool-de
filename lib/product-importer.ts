/**
 * Product importer
 *
 * Takes the raw, scraped product data (from lib/scraper.ts), optionally
 * enriched with AI-optimized content, and turns it into a product in the
 * specified Shopify store:
 *
 *  Copied 1:1:
 *   - Images in exact order (with metadata stripped, renamed)
 *   - Color/size variants in exact order, each variant linked to the same
 *     image as on the competitor's page
 *   - Sales channels: Online Store + Point of Sale
 *
 *  Optimized:
 *   - Images: metadata stripped, renamed to `${slug}-${n}.ext`, new SEO
 *     alt text (in the chosen language)
 *   - Vendor: always the store's own name, never the competitor's
 *   - Price: `competitor price ± setting`, rounded to .95; optionally a
 *     compare-at price for a 30-50% discount
 *   - Track quantity: always off
 *
 *  Additional:
 *   - Collection matching: automatically picks the best-fitting collection
 *     from the (store-specific) collection list. No match -> no
 *     collection assigned, but a note is included in the result.
 *   - Translation: alt text is generated in the chosen language (title/
 *     description/meta already arrive translated via `overrides`, since
 *     those are generated per language in content-optimizer.ts).
 */

import { shopifyGraphQL } from "./shopify-client";
import { processProductImage } from "./image-processor";
import { generateAltTexts } from "./alt-text-generator";
import { calculatePricing, type DiscountType } from "./price-calculator";
import { resolveCompetitorPrice } from "./currency";
import { fetchStoreCollections, matchCollection } from "./collection-matcher";
import { matchTaxonomyCategory } from "./category-matcher";
import { determineCategoryMetafields, findRelatedProductsCollectionMetafield } from "./category-metafield-matcher";
import { translateVariantOptions } from "./variant-translator";
import { extractSizeChart } from "./size-chart-extractor";
import { slugify } from "./slug";
import type { LanguageCode } from "./languages";
import type { ShopifyProductRaw } from "./scraper";

export type ImportResult =
  | {
      success: true;
      productId: string;
      productHandle: string;
      adminUrl: string;
      collectionNote?: string;
      currencyNote?: string;
    }
  | { success: false; reason: string };

export type ContentOverrides = {
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  seoTitle?: string;
  seoDescription?: string;
  coreProductType?: string; // always English — reliable source for category matching
  gender?: string; // "Women" or "Men" — used to also link the broader gender collection
};

export type PricingOptions = {
  adjustmentEur: number;
  discountType: DiscountType | "none";
};

const PRODUCT_SET_MUTATION = `
  mutation CreateProductFromCompetitor($synchronous: Boolean!, $productSet: ProductSetInput!) {
    productSet(synchronous: $synchronous, input: $productSet) {
      product {
        id
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PUBLICATIONS_QUERY = `
  query GetPublications {
    publications(first: 10) {
      nodes {
        id
        name
      }
    }
  }
`;

const PUBLISH_MUTATION = `
  mutation PublishToChannels($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;

// Fallback: on some stores/products, the category doesn't always stick via
// productSet. A separate productUpdate call right after creation proved
// more reliable.
const PRODUCT_UPDATE_CATEGORY_MUTATION = `
  mutation UpdateProductCategory($input: ProductUpdateInput!) {
    productUpdate(product: $input) {
      product {
        id
        category {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const SHOP_CURRENCY_QUERY = `
  query GetShopCurrency {
    shop {
      currencyCode
    }
  }
`;

type ShopCurrencyResponse = {
  shop: { currencyCode: string };
};

type ProductSetResponse = {
  productSet: {
    product: { id: string; handle: string } | null;
    userErrors: { field: string[]; message: string }[];
  };
};

type PublicationsResponse = {
  publications: { nodes: { id: string; name: string }[] };
};

type PublishResponse = {
  publishablePublish: {
    userErrors: { field: string[]; message: string }[];
  };
};

type ProductUpdateCategoryResponse = {
  productUpdate: {
    product: { id: string; category: { id: string; name: string } | null } | null;
    userErrors: { field: string[]; message: string }[];
  };
};

type FileInput = {
  originalSource: string;
  alt: string;
  filename: string;
  contentType: "IMAGE";
};

/**
 * Processes all product images: download, strip metadata, rename to
 * `${slug}-${n}.ext`, and upload to Shopify. Also generates alt text via
 * AI, in the chosen language. Returns the ready-to-use "files" array, in
 * the same order as the original competitor images.
 */
async function buildFilesInput(
  product: ShopifyProductRaw,
  slug: string,
  storeDomain: string,
  accessToken: string,
  language: LanguageCode
): Promise<FileInput[]> {
  const sortedImages = [...product.images].sort((a, b) => a.position - b.position);

  const altTexts = await generateAltTexts(
    sortedImages.map((img) => img.src),
    product.title,
    language
  );

  const processed = await Promise.all(
    sortedImages.map((img, index) => processProductImage(img.src, slug, index + 1, storeDomain, accessToken))
  );

  return processed.map((p, index) => ({
    originalSource: p.resourceUrl,
    alt: altTexts[index],
    filename: p.filename,
    contentType: "IMAGE" as const,
  }));
}

/**
 * Looks up the image index associated with a variant, the same way
 * Shopify itself does: via images[].variant_ids.
 */
function findVariantImageIndex(product: ShopifyProductRaw, variantId: number): number {
  const sortedImages = [...product.images].sort((a, b) => a.position - b.position);
  return sortedImages.findIndex((img) => img.variant_ids.includes(variantId));
}

/**
 * Builds the productOptions + variants input: exact order and exact
 * color-to-image linking as on the competitor's page, plus the calculated
 * price/compare-at price and track-quantity-off.
 */
async function buildOptionsAndVariants(
  product: ShopifyProductRaw,
  files: FileInput[],
  pricing: PricingOptions,
  language: LanguageCode,
  sourceUrl: string,
  targetCurrency: string
) {
  const sortedOptions = [...product.options].sort((a, b) => a.position - b.position);
  const translations = await translateVariantOptions(sortedOptions, language);

  const productOptions = sortedOptions.map((opt) => ({
    name: translations.optionNames[opt.name] ?? opt.name,
    position: opt.position,
    values: opt.values.map((v) => ({ name: translations.optionValues[`${opt.name}:${v}`] ?? v })),
  }));

  const sortedVariants = [...product.variants].sort((a, b) => a.position - b.position);

  // By agreement, the competitor always has 1 price for the whole product
  // (never different per variant), so we base the calculation on the
  // first variant and apply it to all variants.
  const rawCompetitorPrice = parseFloat(sortedVariants[0]?.price ?? "0");
  console.log(`[product-importer] Raw competitor price (before currency check): ${rawCompetitorPrice}`);

  // Some competitors run their store in a different base currency than
  // what they SHOW to visitors — the .json endpoint always returns the
  // raw backend price. We therefore first try to read the actually
  // displayed price directly from the page (most reliable), with
  // sensible fallback options if that doesn't work.
  const resolution = await resolveCompetitorPrice(rawCompetitorPrice, sourceUrl, targetCurrency);
  console.log(`[product-importer] Price resolution:`, resolution);

  let competitorPrice = resolution.amount;
  let currencyNote: string | undefined;

  if (resolution.source === "forced_country") {
    // Best, confirmed method — no note needed.
  } else if (resolution.source === "shopify_embedded_rate" && resolution.converted) {
    currencyNote = `Price converted using the competitor store's own exchange rate (${resolution.originalCurrency} → ${resolution.currency}) — please double-check this is correct.`;
  } else if (resolution.source === "structured_data_guess") {
    currencyNote = resolution.converted
      ? `Price converted based on a guessed currency from the page data (${resolution.originalCurrency} → ${resolution.currency}, rate: ${resolution.rate?.toFixed(4)}). Please check the price manually.`
      : `Price based on page data (currency: ${resolution.currency}), no conversion needed.`;
  } else if (resolution.source === "json_currency_guess") {
    currencyNote = resolution.converted
      ? `Could not confirm the price directly from the page — guessed the currency (${resolution.originalCurrency} → ${resolution.currency}, rate: ${resolution.rate?.toFixed(4)}) based on the raw product data. Please check the price manually.`
      : `Could not confirm the price directly from the page — used the raw product data (currency already appeared correct: ${resolution.currency}). Please check the price manually.`;
  } else if (resolution.source === "raw_fallback") {
    currencyNote = `Could not confirm the price via the page or the store currency — used the raw price (${resolution.amount}) without conversion. Please check the price manually.`;
  }
  // source "shopify_embedded_rate" + converted: false -> price converted
  // using the competitor store's own exact rate, and already came out in
  // our currency. This is the best/safest situation, no note needed.

  console.log(`[product-importer] Competitor price used for calculation: ${competitorPrice}`);
  const { finalPrice, compareAtPrice } = calculatePricing(
    competitorPrice,
    pricing.adjustmentEur,
    pricing.discountType === "none" ? null : pricing.discountType
  );
  console.log(`[product-importer] Calculated finalPrice: ${finalPrice}, compareAtPrice: ${compareAtPrice}`);

  const variants = sortedVariants.map((variant) => {
    const optionValuesRaw = [variant.option1, variant.option2, variant.option3];
    const optionValues = sortedOptions
      .map((opt, i) => {
        const value = optionValuesRaw[i];
        if (!value) return null;
        const translatedName = translations.optionNames[opt.name] ?? opt.name;
        const translatedValue = translations.optionValues[`${opt.name}:${value}`] ?? value;
        return { optionName: translatedName, name: translatedValue };
      })
      .filter((v): v is { optionName: string; name: string } => v !== null);

    const imageIndex = findVariantImageIndex(product, variant.id);
    const linkedFile = imageIndex !== -1 ? files[imageIndex] : undefined;

    return {
      optionValues,
      price: finalPrice.toFixed(2),
      compareAtPrice: compareAtPrice !== null ? compareAtPrice.toFixed(2) : undefined,
      file: linkedFile,
      inventoryItem: { tracked: false }, // track quantity always off
    };
  });

  return { productOptions, variants, currencyNote };
}

export async function importProductToShopify(
  product: ShopifyProductRaw,
  storeDomain: string,
  accessToken: string,
  storeName: string,
  language: LanguageCode,
  sourceUrl: string,
  status: "DRAFT" | "ACTIVE" = "DRAFT",
  overrides?: ContentOverrides,
  pricing: PricingOptions = { adjustmentEur: 0, discountType: "50" },
  skipSizeChart: boolean = false
): Promise<ImportResult> {
  const slug = overrides?.handle || slugify(product.title);
  const finalTitle = overrides?.title || product.title;

  try {
    // Step 0: fetch our own store's currency, needed for price conversion
    // for competitors running in a different currency.
    let targetCurrency = "USD"; // safe fallback if the query unexpectedly fails (US-market instance)
    try {
      const shopCurrencyResult = await shopifyGraphQL<ShopCurrencyResponse>(
        storeDomain,
        accessToken,
        SHOP_CURRENCY_QUERY
      );
      targetCurrency = shopCurrencyResult.shop.currencyCode;
    } catch (err) {
      console.error("[product-importer] Could not fetch store currency, falling back to EUR:", err);
    }

    // Step 1: process images (download, strip EXIF, rename, generate alt
    // text, upload to Shopify) — must be done before calling productSet,
    // since we link variant images within it.
    const files = await buildFilesInput(product, slug, storeDomain, accessToken, language);
    const { productOptions, variants, currencyNote } = await buildOptionsAndVariants(
      product,
      files,
      pricing,
      language,
      sourceUrl,
      targetCurrency
    );

    // Step 2: collection matching — fetch the store-specific list and pick
    // the best-fitting collection. No match = not a hard failure.
    let collectionId: string | undefined;
    let collectionNote: string | undefined;
    const collectionIds: string[] = [];
    try {
      const storeCollections = await fetchStoreCollections(storeDomain, accessToken);
      const matched = await matchCollection(finalTitle, product.product_type, storeCollections);
      if (matched) {
        collectionId = matched.id;
        collectionIds.push(matched.id);
      } else {
        collectionNote = "No matching collection found — please check manually.";
      }

      // Also link the broader gender collection ("Women"/"Men"), in
      // addition to the specific one above — simple exact/near match
      // against the same already-fetched list, no extra API calls needed.
      if (overrides?.gender) {
        const genderWord = overrides.gender.toLowerCase(); // "women" or "men"
        const genderCollection = storeCollections.find((c) => {
          const title = c.title.toLowerCase().trim();
          return title === genderWord || title === `${genderWord}'s` || title === `${genderWord}s`;
        });
        if (genderCollection && !collectionIds.includes(genderCollection.id)) {
          collectionIds.push(genderCollection.id);
        }
      }
    } catch {
      collectionNote = "Collection matching failed — please check manually.";
    }

    // Step 2b: assign Shopify's own standardized product category
    // (separate from the store-specific Collections above). We prefer to
    // use the reliable, always-English coreProductType from the AI
    // optimization for this — the competitor's product_type field is
    // often messy in practice (e.g. "Short Sleeve" instead of "Dress")
    // and produces unusable taxonomy search results.
    const categorySearchTerm = overrides?.coreProductType || product.product_type;
    const taxonomyCategoryId = await matchTaxonomyCategory(
      storeDomain,
      accessToken,
      finalTitle,
      categorySearchTerm
    );

    // Step 2c (experimental): automatically fill in Shopify's "Category
    // metafields" (Color, Neckline, Dress style, etc. — the attributes
    // that appear once a Category is assigned). Best-effort: only
    // attempted if a category was found, and any failure here is safely
    // skipped without affecting the rest of the import.
    let categoryMetafields: { namespace: string; key: string; type: string; value: string }[] = [];
    if (taxonomyCategoryId) {
      const sortedImageUrls = [...product.images].sort((a, b) => a.position - b.position).map((img) => img.src);
      const sizeOption = product.options.find((o) => o.name.toLowerCase() === "size");
      const colorOption = product.options.find((o) => o.name.toLowerCase() === "color" || o.name.toLowerCase() === "colour");
      const strippedDescriptionForMetafields = product.body_html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      categoryMetafields = await determineCategoryMetafields(
        storeDomain,
        accessToken,
        taxonomyCategoryId,
        sortedImageUrls,
        sizeOption?.values ?? [],
        product.title,
        strippedDescriptionForMetafields,
        colorOption?.values ?? []
      );
    }

    // Step 2c-2: if this store has a custom "Related Products"-style
    // collection-reference metafield, automatically point it at the same
    // collection already matched above — so it never needs to be set
    // separately by hand. Best-effort: skipped entirely if no such field
    // exists on this store, or if no collection was matched.
    const relatedProductsMetafield = await findRelatedProductsCollectionMetafield(storeDomain, accessToken, collectionId);
    if (relatedProductsMetafield) {
      categoryMetafields = [...categoryMetafields, relatedProductsMetafield];
    }

    // Step 2d: append the competitor's size chart (table or image) to the
    // end of our generated description, if one can be found. Best-effort
    // — no size chart found simply means the description stays as-is.
    const baseDescriptionHtml = overrides?.descriptionHtml || product.body_html;
    const sizeChartHtml = skipSizeChart ? null : extractSizeChart(product.body_html);
    const finalDescriptionHtml = sizeChartHtml ? `${baseDescriptionHtml}${sizeChartHtml}` : baseDescriptionHtml;
    console.log(`[product-importer] Size chart found and appended: ${sizeChartHtml !== null}`);

    // Step 3: create product + variants + images (+ collection) in one
    // atomic call
    const createResult = await shopifyGraphQL<ProductSetResponse>(
      storeDomain,
      accessToken,
      PRODUCT_SET_MUTATION,
      {
        synchronous: true,
        productSet: {
          title: finalTitle,
          descriptionHtml: finalDescriptionHtml,
          handle: slug,
          vendor: storeName, // always the store's own name, never the competitor's
          productType: categorySearchTerm, // matches the same category we use for Shopify's taxonomy Category field
          status,
          productOptions,
          files,
          variants,
          collections: collectionIds.length > 0 ? collectionIds : undefined,
          category: taxonomyCategoryId || undefined,
          metafields: categoryMetafields.length > 0 ? categoryMetafields : undefined,
          seo:
            overrides?.seoTitle || overrides?.seoDescription
              ? { title: overrides.seoTitle, description: overrides.seoDescription }
              : undefined,
        },
      }
    );

    if (createResult.productSet.userErrors.length > 0) {
      return {
        success: false,
        reason: createResult.productSet.userErrors.map((e) => e.message).join("; "),
      };
    }

    const createdProduct = createResult.productSet.product;
    if (!createdProduct) {
      return { success: false, reason: "Shopify returned no product after creation." };
    }

    // Step 3b: category has not always proven reliable via productSet —
    // if a category was found, we set it again explicitly via a separate
    // productUpdate call. An error here is not a hard failure: the
    // product already exists and can be categorized manually.
    console.log(`[product-importer] taxonomyCategoryId: ${taxonomyCategoryId ?? "(none)"}`);
    if (taxonomyCategoryId) {
      try {
        const categoryUpdateResult = await shopifyGraphQL<ProductUpdateCategoryResponse>(
          storeDomain,
          accessToken,
          PRODUCT_UPDATE_CATEGORY_MUTATION,
          { input: { id: createdProduct.id, category: taxonomyCategoryId } }
        );
        console.log(
          "[product-importer] productUpdate (category) result:",
          JSON.stringify(categoryUpdateResult.productUpdate)
        );
        if (categoryUpdateResult.productUpdate.userErrors.length > 0) {
          console.error(
            "[product-importer] productUpdate userErrors:",
            categoryUpdateResult.productUpdate.userErrors
          );
        }
      } catch (err) {
        console.error("[product-importer] ERROR during productUpdate (category):", err);
      }
    }

    // Step 4: fetch sales channels and publish (Online Store + Point of Sale)
    const pubResult = await shopifyGraphQL<PublicationsResponse>(
      storeDomain,
      accessToken,
      PUBLICATIONS_QUERY
    );

    const targetChannels = pubResult.publications.nodes.filter((pub) =>
      ["online store", "point of sale"].includes(pub.name.toLowerCase())
    );

    if (targetChannels.length > 0) {
      await shopifyGraphQL<PublishResponse>(storeDomain, accessToken, PUBLISH_MUTATION, {
        id: createdProduct.id,
        input: targetChannels.map((c) => ({ publicationId: c.id })),
      });
      // A publishing error is not a hard failure: the product already
      // exists and can be published manually, so we just continue.
    }

    return {
      success: true,
      productId: createdProduct.id,
      productHandle: createdProduct.handle,
      adminUrl: `https://${storeDomain}/admin/products/${createdProduct.id.split("/").pop()}`,
      collectionNote,
      currencyNote,
    };
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : "Unknown error while creating the product.",
    };
  }
}
