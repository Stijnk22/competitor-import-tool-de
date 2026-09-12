import { NextRequest, NextResponse } from "next/server";
import { getKeywordUploadJob } from "@/lib/keyword-upload-store";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getKeywordUploadJob(jobId);

  if (!job) {
    return NextResponse.json({ success: false, reason: "Upload job not found." }, { status: 404 });
  }

  return NextResponse.json({ success: true, job });
}
