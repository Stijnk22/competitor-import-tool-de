"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, type LanguageCode } from "@/lib/languages";
import type { ImportBatch, ImportItemStatus } from "@/lib/batch-store";
import type { StoreSummary } from "@/lib/store-manager";
import type { KeywordLibrarySummary } from "@/lib/keyword-manager";

const STATUS_COLORS: Record<ImportItemStatus, string> = {
  pending: "bg-neutral-100 text-neutral-600",
  processing: "bg-blue-100 text-blue-700",
  success: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

const STATUS_LABELS: Record<ImportItemStatus, string> = {
  pending: "Pending",
  processing: "Processing...",
  success: "Success",
  failed: "Failed",
};

export default function Home() {
  // Store management
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>("");
  const [storesLoading, setStoresLoading] = useState(true);
  const [showAddStore, setShowAddStore] = useState(false);
  const [newStoreName, setNewStoreName] = useState("");
  const [newStoreDomain, setNewStoreDomain] = useState("");
  const [newStoreToken, setNewStoreToken] = useState("");
  const [addingStore, setAddingStore] = useState(false);
  const [storeError, setStoreError] = useState("");

  // Batch import
  const [urlsText, setUrlsText] = useState("");
  const [language, setLanguage] = useState<LanguageCode>(DEFAULT_LANGUAGE);
  const [priceAdjustment, setPriceAdjustment] = useState("-3");
  const productStatus = "DRAFT" as const;
  const [discountType, setDiscountType] = useState<"50" | "40" | "random" | "none">("50");
  const [rephraseMode, setRephraseMode] = useState(false);
  const [starting, setStarting] = useState(false);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keyword library
  const [keywordSummary, setKeywordSummary] = useState<KeywordLibrarySummary[]>([]);
  const [storeCollectionTitles, setStoreCollectionTitles] = useState<string[]>([]);
  const [showKeywordUpload, setShowKeywordUpload] = useState(false);
  const [keywordFile, setKeywordFile] = useState<File | null>(null);
  const [keywordMarket, setKeywordMarket] = useState<LanguageCode>(DEFAULT_LANGUAGE);
  const [keywordCategory, setKeywordCategory] = useState("");
  const [isNewCategory, setIsNewCategory] = useState(false);
  const [uploadingKeywords, setUploadingKeywords] = useState(false);
  const [keywordUploadProgress, setKeywordUploadProgress] = useState<{ processed: number; total: number } | null>(
    null
  );
  const keywordUploadPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [keywordUploadMessage, setKeywordUploadMessage] = useState("");
  const [keywordUploadError, setKeywordUploadError] = useState("");

  const loadKeywordSummary = useCallback(async () => {
    const res = await fetch("/api/keywords");
    const data = await res.json();
    if (data.success) setKeywordSummary(data.summary);
  }, []);

  useEffect(() => {
    loadKeywordSummary();
  }, [loadKeywordSummary]);

  // Fetch the selected store's collection names — reused as suggested
  // categories in the keyword dropdown, so you don't have to separately
  // remember which categories you already have.
  useEffect(() => {
    if (!selectedStoreId) {
      setStoreCollectionTitles([]);
      return;
    }
    fetch(`/api/stores/${selectedStoreId}/collections`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setStoreCollectionTitles(data.collections.map((c: { title: string }) => c.title));
        }
      })
      .catch(() => setStoreCollectionTitles([]));
  }, [selectedStoreId]);

  // Combination of: collection names from Shopify (the "official" list) +
  // categories already used manually in keyword uploads (in case they're
  // named slightly differently than a collection).
  const existingCategories = [
    ...new Set([
      ...storeCollectionTitles.map((t) => t.toLowerCase()),
      ...keywordSummary.map((s) => s.category),
    ]),
  ].sort();

  function stopKeywordUploadPolling() {
    if (keywordUploadPollRef.current) {
      clearInterval(keywordUploadPollRef.current);
      keywordUploadPollRef.current = null;
    }
  }

  function pollKeywordUploadJob(jobId: string) {
    stopKeywordUploadPolling();
    keywordUploadPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/keywords/upload/${jobId}`);
      const data = await res.json();
      if (!data.success) return;

      const job = data.job;
      setKeywordUploadProgress({ processed: job.processedKeywords, total: job.totalKeywords });

      if (job.status === "done") {
        stopKeywordUploadPolling();
        setUploadingKeywords(false);
        setKeywordUploadProgress(null);
        const categoryBreakdown = job.categoryCounts
          ? ` Detected categories: ${Object.entries(job.categoryCounts as Record<string, number>)
              .map(([cat, count]) => `${cat} (${count})`)
              .join(", ")}.`
          : "";
        setKeywordUploadMessage(`${job.savedCount} of ${job.totalKeywords} keywords saved and tagged.${categoryBreakdown}`);
        setKeywordFile(null);
        setKeywordCategory("");
        setIsNewCategory(false);
        loadKeywordSummary();
      } else if (job.status === "failed") {
        stopKeywordUploadPolling();
        setUploadingKeywords(false);
        setKeywordUploadProgress(null);
        setKeywordUploadError(job.errorReason || "Upload failed.");
      }
    }, 2000);
  }

  useEffect(() => stopKeywordUploadPolling, []);

  async function handleKeywordUpload() {
    setKeywordUploadError("");
    setKeywordUploadMessage("");
    if (!keywordFile) {
      setKeywordUploadError("Choose a CSV file first.");
      return;
    }
    if (!keywordCategory.trim()) {
      setKeywordUploadError("Choose or enter a category.");
      return;
    }
    setUploadingKeywords(true);
    try {
      const formData = new FormData();
      formData.append("file", keywordFile);
      formData.append("market", keywordMarket);
      formData.append("category", keywordCategory.trim());

      const res = await fetch("/api/keywords", { method: "POST", body: formData });
      const data = await res.json();
      if (!data.success) {
        setKeywordUploadError(data.reason || "Upload failed.");
        setUploadingKeywords(false);
        return;
      }

      if (data.jobId) {
        // Bulk mode: large upload processing in the background — poll for
        // progress. uploadingKeywords stays true until the job finishes
        // (handled inside pollKeywordUploadJob), so no reset here.
        setKeywordUploadProgress({ processed: 0, total: data.totalParsed });
        pollKeywordUploadJob(data.jobId);
        return;
      }

      // Single-category mode: already complete.
      setKeywordUploadMessage(`${data.savedCount} of ${data.totalParsed} keywords saved and tagged.`);
      setKeywordFile(null);
      setKeywordCategory("");
      setIsNewCategory(false);
      await loadKeywordSummary();
      setUploadingKeywords(false);
    } catch (err) {
      setKeywordUploadError(err instanceof Error ? err.message : "Upload failed.");
      setUploadingKeywords(false);
    }
  }

  async function handleDeleteKeywordCategory(market: string, category: string) {
    if (!confirm(`Are you sure you want to delete all keywords for "${category}" (${market})?`)) return;
    await fetch(`/api/keywords?market=${encodeURIComponent(market)}&category=${encodeURIComponent(category)}`, {
      method: "DELETE",
    });
    await loadKeywordSummary();
  }

  const loadStores = useCallback(async () => {
    setStoresLoading(true);
    try {
      const res = await fetch("/api/stores");
      const data = await res.json();
      if (data.success) {
        setStores(data.stores);
        // Automatically select the first store if none is selected yet
        setSelectedStoreId((current) => current || data.stores[0]?.id || "");
      }
    } finally {
      setStoresLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStores();
  }, [loadStores]);

  async function handleAddStore() {
    setStoreError("");
    if (!newStoreName.trim() || !newStoreDomain.trim() || !newStoreToken.trim()) {
      setStoreError("Please fill in all three fields.");
      return;
    }
    setAddingStore(true);
    try {
      const res = await fetch("/api/stores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newStoreName,
          shopifyDomain: newStoreDomain,
          accessToken: newStoreToken,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setNewStoreName("");
        setNewStoreDomain("");
        setNewStoreToken("");
        setShowAddStore(false);
        await loadStores();
        setSelectedStoreId(data.store.id);
      } else {
        setStoreError(data.reason || "Could not add store.");
      }
    } finally {
      setAddingStore(false);
    }
  }

  async function handleDeleteStore(id: string) {
    if (!confirm("Are you sure you want to delete this store?")) return;
    await fetch(`/api/stores/${id}`, { method: "DELETE" });
    await loadStores();
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(batchId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/batch/${batchId}`);
      const data = await res.json();
      if (data.success) {
        setBatch(data.batch);
        const allDone = data.batch.items.every(
          (i: { status: ImportItemStatus }) => i.status === "success" || i.status === "failed"
        );
        if (allDone) stopPolling();
      }
    }, 2000);
  }

  useEffect(() => stopPolling, []);

  async function handleStart() {
    if (!selectedStoreId) {
      alert("Please select a store first.");
      return;
    }
    setStarting(true);
    setBatch(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: urlsText,
          language,
          priceAdjustmentEur: parseFloat(priceAdjustment) || 0,
          storeId: selectedStoreId,
          productStatus,
          discountType,
          rephraseMode,
        }),
      });
      const data = await res.json();
      if (data.success) {
        startPolling(data.batchId);
      } else {
        alert(data.reason || "Could not start batch.");
      }
    } finally {
      setStarting(false);
    }
  }

  const urlCount = urlsText
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean).length;

  const doneCount = batch ? batch.items.filter((i) => i.status === "success").length : 0;
  const failedCount = batch ? batch.items.filter((i) => i.status === "failed").length : 0;
  const remainingCount = batch
    ? batch.items.filter((i) => i.status === "pending" || i.status === "processing").length
    : 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Competitor Import Tool</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Choose a store, paste multiple competitor URLs at once (one per
        line), and follow progress live. Products are always created as{" "}
        <strong>Draft</strong>.
      </p>

      {/* Store management */}
      <div className="mt-6 rounded-md border border-neutral-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-neutral-700">Stores</p>
          <button
            onClick={() => setShowAddStore((v) => !v)}
            className="text-xs font-medium text-blue-600 underline"
          >
            {showAddStore ? "Cancel" : "+ Add store"}
          </button>
        </div>

        {showAddStore && (
          <div className="mt-3 space-y-2 rounded-md border border-neutral-100 bg-neutral-50 p-3">
            <input
              type="text"
              placeholder="Name (e.g. Wilson & Co London)"
              value={newStoreName}
              onChange={(e) => setNewStoreName(e.target.value)}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <input
              type="text"
              placeholder="Shopify domain (e.g. wilson-co-london.myshopify.com)"
              value={newStoreDomain}
              onChange={(e) => setNewStoreDomain(e.target.value)}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <input
              type="password"
              placeholder="Admin API access token (shpat_...)"
              value={newStoreToken}
              onChange={(e) => setNewStoreToken(e.target.value)}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            />
            {storeError && <p className="text-xs text-red-600">{storeError}</p>}
            <button
              onClick={handleAddStore}
              disabled={addingStore}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {addingStore ? "Adding..." : "Save"}
            </button>
          </div>
        )}

        <div className="mt-3">
          {storesLoading ? (
            <p className="text-xs text-neutral-400">Loading stores...</p>
          ) : stores.length === 0 ? (
            <p className="text-xs text-neutral-400">
              No stores added yet — add one to get started.
            </p>
          ) : (
            <div className="space-y-1">
              {stores.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
                    selectedStoreId === s.id
                      ? "border-blue-300 bg-blue-50"
                      : "border-neutral-200 bg-white"
                  }`}
                >
                  <button
                    onClick={() => setSelectedStoreId(s.id)}
                    className="flex-1 text-left"
                  >
                    <span className="font-medium text-neutral-800">{s.name}</span>{" "}
                    <span className="text-neutral-400">— {s.shopifyDomain}</span>
                    {selectedStoreId === s.id && (
                      <span className="ml-2 text-blue-600">(active)</span>
                    )}
                  </button>
                  <button
                    onClick={() => handleDeleteStore(s.id)}
                    className="ml-3 text-red-500 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Keyword library */}
      <div className="mt-6 rounded-md border border-neutral-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-neutral-700">Keywords</p>
          <button
            onClick={() => setShowKeywordUpload((v) => !v)}
            className="text-xs font-medium text-blue-600 underline"
          >
            {showKeywordUpload ? "Cancel" : "+ Upload CSV"}
          </button>
        </div>

        {showKeywordUpload && (
          <div className="mt-3 space-y-2 rounded-md border border-neutral-100 bg-neutral-50 p-3">
            <p className="text-xs text-neutral-500">
              Upload a raw Google Keyword Planner export (.csv). Every keyword is
              automatically tagged (core product / material / closure style / etc.)
              — you don&apos;t need to do that yourself.
            </p>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => setKeywordFile(e.target.files?.[0] ?? null)}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            />
            <div className="flex gap-2">
              <select
                value={keywordMarket}
                onChange={(e) => setKeywordMarket(e.target.value as LanguageCode)}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              >
                {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
              {keywordCategory === "__auto__" ? (
                <div className="flex flex-1 items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-sm text-blue-700">
                  <span>Auto-detecting categories from file</span>
                  <button type="button" onClick={() => setKeywordCategory("")} className="text-xs underline">
                    Cancel
                  </button>
                </div>
              ) : isNewCategory || existingCategories.length === 0 ? (
                <input
                  type="text"
                  placeholder="New category (e.g. heels, dresses)"
                  value={keywordCategory}
                  onChange={(e) => setKeywordCategory(e.target.value)}
                  className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                />
              ) : (
                <select
                  value={keywordCategory}
                  onChange={(e) => {
                    if (e.target.value === "__new__") {
                      setIsNewCategory(true);
                      setKeywordCategory("");
                    } else {
                      setKeywordCategory(e.target.value);
                    }
                  }}
                  className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                >
                  <option value="" disabled>
                    Choose a category...
                  </option>
                  {existingCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                  <option value="__new__">+ Add new category...</option>
                </select>
              )}
              {keywordCategory !== "__auto__" && (
                <button
                  type="button"
                  onClick={() => {
                    setKeywordCategory("__auto__");
                    setIsNewCategory(false);
                  }}
                  className="whitespace-nowrap text-xs text-blue-600 underline"
                  title="For files mixing multiple product categories — AI detects the category per keyword automatically."
                >
                  Auto-detect
                </button>
              )}
              {isNewCategory && existingCategories.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setIsNewCategory(false);
                    setKeywordCategory("");
                  }}
                  className="text-xs text-neutral-500 underline"
                >
                  Back to list
                </button>
              )}
            </div>
            {keywordUploadError && <p className="text-xs text-red-600">{keywordUploadError}</p>}
            {keywordUploadMessage && <p className="text-xs text-green-700">{keywordUploadMessage}</p>}
            <button
              onClick={handleKeywordUpload}
              disabled={uploadingKeywords}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {uploadingKeywords
                ? keywordUploadProgress
                  ? `Tagging ${keywordUploadProgress.processed} of ${keywordUploadProgress.total}...`
                  : "Processing..."
                : "Upload & tag"}
            </button>
          </div>
        )}

        <div className="mt-3">
          {keywordSummary.length === 0 ? (
            <p className="text-xs text-neutral-400">
              No keywords uploaded yet — titles are currently logically optimized
              instead of based on search volume.
            </p>
          ) : (
            <div className="space-y-1">
              {keywordSummary.map((s) => (
                <div
                  key={`${s.market}-${s.category}`}
                  className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs"
                >
                  <span>
                    <span className="font-medium text-neutral-800">{s.category}</span>{" "}
                    <span className="text-neutral-400">
                      — {SUPPORTED_LANGUAGES[s.market as LanguageCode] ?? s.market} — {s.count} keywords
                    </span>
                  </span>
                  <button
                    onClick={() => handleDeleteKeywordCategory(s.market, s.category)}
                    className="text-red-500 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <textarea
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          placeholder={
            "https://competitor-store.com/products/product-1\nhttps://competitor-store.com/products/product-2\n..."
          }
          rows={8}
          className="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-sm outline-none focus:border-neutral-500"
        />
        <p className="text-xs text-neutral-400">
          {urlCount} URL{urlCount !== 1 ? "s" : ""} found
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-neutral-600">Language</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageCode)}
              className="mt-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600">
              Price adjustment (€, may be negative)
            </label>
            <input
              type="number"
              step="0.01"
              value={priceAdjustment}
              onChange={(e) => setPriceAdjustment(e.target.value)}
              className="mt-1 w-28 rounded-md border border-neutral-300 px-2 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600">Product status</label>
            <div className="mt-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              Draft
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600">Discount</label>
            <select
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as "50" | "40" | "random" | "none")}
              className="mt-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              <option value="50">50% off</option>
              <option value="40">40% off</option>
              <option value="random">Random (20-35% off)</option>
              <option value="none">No discount</option>
            </select>
          </div>
          <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={rephraseMode}
              onChange={(e) => setRephraseMode(e.target.checked)}
              className="h-4 w-4 rounded border-neutral-300"
            />
            Rephrase mode
          </label>
          <button
            onClick={handleStart}
            disabled={starting || urlCount === 0 || !selectedStoreId}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {starting ? "Starting..." : `Start import (${urlCount})`}
          </button>
        </div>
      </div>

      {batch && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-neutral-700">
            Progress — {doneCount} succeeded, {failedCount} failed, {remainingCount}{" "}
            processing/pending
          </h2>

          <div className="mt-3 space-y-2">
            {batch.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 bg-white p-3 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-neutral-700">
                    {item.resultTitle || item.sourceUrl}
                  </p>
                  {item.status === "failed" && (
                    <p className="mt-0.5 text-red-600">{item.failureReason}</p>
                  )}
                  {item.status === "success" && item.collectionNote && (
                    <p className="mt-0.5 text-amber-600">⚠ {item.collectionNote}</p>
                  )}
                  {item.status === "success" && item.currencyNote && (
                    <p className="mt-0.5 text-amber-600">⚠ {item.currencyNote}</p>
                  )}
                  {item.status === "success" && batch?.discountType !== "none" && (
                    <p className="mt-0.5 text-purple-600">
                      Discount applied (
                      {batch?.discountType === "50" ? "50%" : batch?.discountType === "40" ? "40%" : "20-35%"})
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {item.status === "success" && item.shopifyAdminUrl && (
                    <a
                      href={item.shopifyAdminUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline"
                    >
                      View →
                    </a>
                  )}
                  <span className={`rounded px-2 py-1 font-medium ${STATUS_COLORS[item.status]}`}>
                    {STATUS_LABELS[item.status]}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
