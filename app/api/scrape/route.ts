import { NextRequest, NextResponse } from "next/server";
import { scrapeCompetitorProduct } from "@/lib/scraper";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const url = body?.url;

  if (!url || typeof url !== "string") {
    return NextResponse.json(
      { success: false, reason: "No valid URL provided." },
      { status: 400 }
    );
  }

  const result = await scrapeCompetitorProduct(url);
  return NextResponse.json(result);
}
