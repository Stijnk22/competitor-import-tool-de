import { NextRequest, NextResponse } from "next/server";
import { parseKeywordPlannerCsv } from "@/lib/keyword-csv-parser";
import { tagKeywords, tagKeywordsBulk } from "@/lib/keyword-tagger";
import { storeKeywords, storeKeywordsBulk, listKeywordLibrarySummary, deleteKeywordCategory } from "@/lib/keyword-manager";
import { isValidLanguageCode } from "@/lib/languages";
import { createKeywordUploadJob, updateKeywordUploadJob } from "@/lib/keyword-upload-store";

/**
 * Some exports (e.g. opened and re-saved via Excel/Numbers) are UTF-16
 * encoded instead of UTF-8 — file.text() always decodes as UTF-8, which
 * for UTF-16 only produces unreadable characters. This function detects
 * the encoding from the BOM marker (if present) and decodes accordingly.
 */
async function readFileAsText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // UTF-16 LE BOM: FF FE
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer);
  }
  // UTF-16 BE BOM: FE FF
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer);
  }
  // UTF-8 (with or without BOM) — default case
  return new TextDecoder("utf-8").decode(buffer);
}

export async function GET() {
  try {
    const summary = await listKeywordLibrarySummary();
    return NextResponse.json({ success: true, summary });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not fetch summary." },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const market = req.nextUrl.searchParams.get("market");
  const category = req.nextUrl.searchParams.get("category");
  if (!market || !category) {
    return NextResponse.json({ success: false, reason: "Market and category are required." }, { status: 400 });
  }
  try {
    await deleteKeywordCategory(market, category);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not delete." },
      { status: 500 }
    );
  }
}

/**
 * Runs the bulk tagging + storing in the background (fire-and-forget) and
 * reports live progress via the keyword-upload-store, so the frontend can
 * poll instead of waiting on a single, potentially multi-minute request —
 * needed for large files (thousands of keywords, hundreds of AI batches).
 */
async function processBulkUploadInBackground(jobId: string, market: string, parsed: Awaited<ReturnType<typeof parseKeywordPlannerCsv>>) {
  try {
    const tagged = await tagKeywordsBulk(parsed, (processed, total) => {
      updateKeywordUploadJob(jobId, { processedKeywords: processed });
      console.log(`[keywords] Job ${jobId}: ${processed}/${total} keywords tagged`);
    });
    const { savedCount, categoryCounts } = await storeKeywordsBulk(market, tagged);
    console.log(`[keywords] Job ${jobId} complete:`, categoryCounts);
    updateKeywordUploadJob(jobId, { status: "done", savedCount, categoryCounts, processedKeywords: parsed.length });
  } catch (err) {
    console.error(`[keywords] Job ${jobId} failed:`, err);
    updateKeywordUploadJob(jobId, {
      status: "failed",
      errorReason: err instanceof Error ? err.message : "Unknown error while processing keywords.",
    });
  }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ success: false, reason: "Invalid upload." }, { status: 400 });
  }

  const file = formData.get("file");
  const market = formData.get("market");
  const category = formData.get("category");

  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, reason: "No file provided." }, { status: 400 });
  }
  if (typeof market !== "string" || !isValidLanguageCode(market)) {
    return NextResponse.json({ success: false, reason: "Invalid or missing market." }, { status: 400 });
  }
  if (typeof category !== "string" || category.trim().length === 0) {
    return NextResponse.json({ success: false, reason: "Category is required." }, { status: 400 });
  }

  const csvText = await readFileAsText(file);
  console.log(`[keywords] File received: ${file.name}, size: ${file.size} bytes`);
  console.log(`[keywords] Preview after decoding:`, JSON.stringify(csvText.slice(0, 300)));

  const parsed = parseKeywordPlannerCsv(csvText);
  console.log(`[keywords] Number of parsed rows: ${parsed.length}`);

  // De-duplicate exact keyword text (keeping the first occurrence) — at
  // larger scale (thousands of rows), accidental duplicates become more
  // likely and just waste AI calls without adding any value.
  const seen = new Set<string>();
  const deduped = parsed.filter((row) => {
    const key = row.keyword.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length !== parsed.length) {
    console.log(`[keywords] Removed ${parsed.length - deduped.length} duplicate keyword(s), ${deduped.length} remain`);
  }

  if (deduped.length === 0) {
    return NextResponse.json(
      { success: false, reason: "No usable keyword rows found in this file." },
      { status: 400 }
    );
  }

  const normalizedCategory = category.trim().toLowerCase();

  if (normalizedCategory === "__auto__") {
    // Bulk mode: the file mixes multiple product categories together — the
    // AI determines both category and attribute slot per keyword. This can
    // take several minutes for large files, so it runs in the background;
    // the frontend polls /api/keywords/upload/{jobId} for progress.
    const jobId = crypto.randomUUID();
    createKeywordUploadJob(jobId, deduped.length);
    console.log(`[keywords] Starting bulk upload job ${jobId} for ${deduped.length} keywords`);

    processBulkUploadInBackground(jobId, market, deduped).catch((err) => {
      console.error(`[keywords] Unexpected error starting job ${jobId}:`, err);
    });

    return NextResponse.json({ success: true, jobId, totalParsed: deduped.length });
  }

  // Single-category mode: typically small uploads, fast enough to handle
  // as a normal synchronous request.
  try {
    const tagged = await tagKeywords(normalizedCategory, deduped);
    const savedCount = await storeKeywords(market, normalizedCategory, tagged);

    return NextResponse.json({
      success: true,
      savedCount,
      totalParsed: deduped.length,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not process keywords." },
      { status: 500 }
    );
  }
}
