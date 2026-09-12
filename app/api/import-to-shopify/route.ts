import { NextRequest, NextResponse } from "next/server";
import { importProductToShopify, type ContentOverrides, type PricingOptions } from "@/lib/product-importer";
import { DEFAULT_LANGUAGE, isValidLanguageCode } from "@/lib/languages";
import type { ShopifyProductRaw } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const product: ShopifyProductRaw | undefined = body?.product;
  const optimized:
    | {
        title?: string;
        slug?: string;
        descriptionHtml?: string;
        metaTitle?: string;
        metaDescription?: string;
        coreProductTypeEnglish?: string;
        gender?: string;
      }
    | undefined = body?.optimized;
  const priceAdjustmentEur: number = typeof body?.priceAdjustmentEur === "number" ? body.priceAdjustmentEur : 0;
  const discountType: "50" | "40" | "random" | "none" =
    body?.discountType === "40" || body?.discountType === "random" || body?.discountType === "none"
      ? body.discountType
      : "50";
  const languageInput: string | undefined = body?.language;
  const language = languageInput && isValidLanguageCode(languageInput) ? languageInput : DEFAULT_LANGUAGE;
  const sourceUrl: string = typeof body?.sourceUrl === "string" ? body.sourceUrl : "";
  const productStatus: "DRAFT" | "ACTIVE" = body?.productStatus === "ACTIVE" ? "ACTIVE" : "DRAFT";

  if (!product || !product.title) {
    return NextResponse.json(
      { success: false, reason: "No valid product data provided." },
      { status: 400 }
    );
  }

  const storeDomain = process.env.SHOPIFY_TEST_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_TEST_STORE_ACCESS_TOKEN;
  const storeName = process.env.SHOPIFY_TEST_STORE_NAME || "our store";

  if (!storeDomain || !accessToken) {
    return NextResponse.json(
      {
        success: false,
        reason:
          "SHOPIFY_TEST_STORE_DOMAIN and/or SHOPIFY_TEST_STORE_ACCESS_TOKEN are not set in .env.local.",
      },
      { status: 400 }
    );
  }

  const overrides: ContentOverrides | undefined = optimized
    ? {
        title: optimized.title,
        descriptionHtml: optimized.descriptionHtml,
        handle: optimized.slug,
        seoTitle: optimized.metaTitle,
        seoDescription: optimized.metaDescription,
        coreProductType: optimized.coreProductTypeEnglish,
        gender: optimized.gender,
      }
    : undefined;

  const pricing: PricingOptions = { adjustmentEur: priceAdjustmentEur, discountType };

  const result = await importProductToShopify(
    product,
    storeDomain,
    accessToken,
    storeName,
    language,
    sourceUrl,
    productStatus,
    overrides,
    pricing
  );

  return NextResponse.json(result);
}
