import { NextRequest, NextResponse } from "next/server";
import { deleteStore } from "@/lib/store-manager";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  try {
    await deleteStore(storeId);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not delete store." },
      { status: 500 }
    );
  }
}
