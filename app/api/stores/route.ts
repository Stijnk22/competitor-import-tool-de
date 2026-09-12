import { NextRequest, NextResponse } from "next/server";
import { listStores, createStore } from "@/lib/store-manager";

export async function GET() {
  try {
    const stores = await listStores();
    return NextResponse.json({ success: true, stores });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not fetch stores." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name: string | undefined = body?.name;
  const shopifyDomain: string | undefined = body?.shopifyDomain;
  const accessToken: string | undefined = body?.accessToken;

  if (!name || !shopifyDomain || !accessToken) {
    return NextResponse.json(
      { success: false, reason: "Name, Shopify domain, and access token are all required." },
      { status: 400 }
    );
  }

  try {
    const store = await createStore(name.trim(), shopifyDomain.trim(), accessToken.trim());
    return NextResponse.json({ success: true, store });
  } catch (err) {
    return NextResponse.json(
      { success: false, reason: err instanceof Error ? err.message : "Could not create store." },
      { status: 500 }
    );
  }
}
