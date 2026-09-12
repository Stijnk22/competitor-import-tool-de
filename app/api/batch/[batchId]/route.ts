import { NextRequest, NextResponse } from "next/server";
import { getBatch } from "@/lib/batch-store";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const batch = getBatch(batchId);

  if (!batch) {
    return NextResponse.json({ success: false, reason: "Batch not found." }, { status: 404 });
  }

  return NextResponse.json({ success: true, batch });
}
