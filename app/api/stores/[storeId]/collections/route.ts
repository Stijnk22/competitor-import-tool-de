import { NextRequest, NextResponse } from "next/server";
import { getStoreWithCredentials } from "@/lib/store-manager";
import { fetchStoreCollections } from "@/lib/collection-matcher";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;

  try {
    const store = await getStoreWithCredentials(storeId);
    if (!store) {
      return NextResponse.json({ success: false, reason: "Store not found." }, { status: 404 });
    }

    const collections = await fetchStoreCollections(store.shopifyDomain, store.accessToken);
    return NextResponse.json({ success: true, collections });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not fetch collections." },
      { status: 500 }
    );
  }
}
