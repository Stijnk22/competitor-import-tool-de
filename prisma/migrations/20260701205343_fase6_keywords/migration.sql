-- CreateTable
CREATE TABLE "keyword_library" (
    "id" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "attribute_slot" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "search_volume" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keyword_library_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "keyword_library_market_category_attribute_slot_idx" ON "keyword_library"("market", "category", "attribute_slot");
