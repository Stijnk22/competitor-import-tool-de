/**
 * Database client
 *
 * Standard Next.js pattern: reuse a single Prisma instance during
 * development, so hot-reloading doesn't open a new database connection
 * every time.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
