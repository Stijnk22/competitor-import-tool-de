/**
 * Store manager
 *
 * CRUD for stores. Tokens are automatically encrypted/decrypted here
 * (see lib/encryption.ts) — the rest of the application just works with
 * plain text tokens and doesn't need to worry about encryption.
 */

import { prisma } from "./db";
import { encrypt, decrypt } from "./encryption";

export type StoreSummary = {
  id: string;
  name: string;
  shopifyDomain: string;
  createdAt: Date;
};

export type StoreWithCredentials = StoreSummary & {
  accessToken: string;
};

export async function listStores(): Promise<StoreSummary[]> {
  const stores = await prisma.store.findMany({ orderBy: { createdAt: "desc" } });
  return stores.map(
    (s: { id: string; name: string; shopifyDomain: string; createdAt: Date }) => ({
      id: s.id,
      name: s.name,
      shopifyDomain: s.shopifyDomain,
      createdAt: s.createdAt,
    })
  );
}

export async function getStoreWithCredentials(id: string): Promise<StoreWithCredentials | null> {
  const store = await prisma.store.findUnique({ where: { id } });
  if (!store) return null;
  return {
    id: store.id,
    name: store.name,
    shopifyDomain: store.shopifyDomain,
    createdAt: store.createdAt,
    accessToken: decrypt(store.accessToken),
  };
}

export async function createStore(
  name: string,
  shopifyDomain: string,
  accessToken: string
): Promise<StoreSummary> {
  const store = await prisma.store.create({
    data: {
      name,
      shopifyDomain,
      accessToken: encrypt(accessToken),
    },
  });
  return {
    id: store.id,
    name: store.name,
    shopifyDomain: store.shopifyDomain,
    createdAt: store.createdAt,
  };
}

export async function deleteStore(id: string): Promise<void> {
  await prisma.store.delete({ where: { id } });
}
