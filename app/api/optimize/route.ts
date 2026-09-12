import { NextRequest, NextResponse } from "next/server";
import { generateOptimizedContent } from "@/lib/content-optimizer";
import { DEFAULT_LANGUAGE, isValidLanguageCode } from "@/lib/languages";
import type { ShopifyProductRaw } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const product: ShopifyProductRaw | undefined = body?.product;
  const languageInput: string | undefined = body?.language;
  const language = languageInput && isValidLanguageCode(languageInput) ? languageInput : DEFAULT_LANGUAGE;

  if (!product || !product.title) {
    return NextResponse.json(
      { success: false, reason: "No valid product data provided." },
      { status: 400 }
    );
  }

  // No multi-store dropdown yet at this stage — store name comes from env,
  // with a sensible fallback so this also works without configuration.
  const storeName = process.env.SHOPIFY_TEST_STORE_NAME || "our store";

  try {
    const optimized = await generateOptimizedContent(product, storeName, language);
    return NextResponse.json({ success: true, optimized });
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        reason: err instanceof Error ? err.message : "Unknown error during content generation.",
      },
      { status: 500 }
    );
  }
}
