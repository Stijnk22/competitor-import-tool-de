import { NextRequest, NextResponse } from "next/server";
import { createBatch } from "@/lib/batch-store";
import { processBatchInBackground } from "@/lib/batch-processor";
import { DEFAULT_LANGUAGE, isValidLanguageCode } from "@/lib/languages";
import type { DiscountType } from "@/lib/price-calculator";
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const urlsRaw: string | undefined = body?.urls;
  const languageInput: string | undefined = body?.language;
  const priceAdjustmentEur: number = typeof body?.priceAdjustmentEur === "number" ? body.priceAdjustmentEur : 0;
  const storeId: string | undefined = body?.storeId;
  const productStatus: "DRAFT" | "ACTIVE" = body?.productStatus === "ACTIVE" ? "ACTIVE" : "DRAFT";
  const discountType: DiscountType | "none" =
    body?.discountType === "40" || body?.discountType === "random" || body?.discountType === "none"
      ? body.discountType
      : "50";
  const rephraseMode: boolean = body?.rephraseMode === true;
  if (!storeId) {
    return NextResponse.json({ success: false, reason: "No store selected." }, { status: 400 });
  }
  if (!urlsRaw || typeof urlsRaw !== "string") {
    return NextResponse.json({ success: false, reason: "No URLs provided." }, { status: 400 });
  }
  const urls = urlsRaw
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) {
    return NextResponse.json({ success: false, reason: "No valid URLs found." }, { status: 400 });
  }
  const language = languageInput && isValidLanguageCode(languageInput) ? languageInput : DEFAULT_LANGUAGE;
  const batchId = crypto.randomUUID();
  createBatch(batchId, storeId, language, priceAdjustmentEur, urls, productStatus, discountType, rephraseMode);
  // Fire-and-forget: we don't wait for this here, the client polls the status route.
  processBatchInBackground(batchId).catch((err) => {
    console.error("Error during batch processing:", err);
  });
  return NextResponse.json({ success: true, batchId });
}
