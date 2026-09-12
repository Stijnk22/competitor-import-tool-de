/**
 * Keyword upload store
 *
 * Tracks the progress of a (potentially large) keyword upload in the
 * memory of the running server — same pattern as batch-store.ts for
 * product import batches. Needed once uploads get large (thousands of
 * keywords): tagging happens in many small AI calls, which can take
 * several minutes in total, too long for a single blocking HTTP request.
 * The upload starts in the background and the frontend polls this store
 * for live progress instead.
 */

export type KeywordUploadStatus = "processing" | "done" | "failed";

export type KeywordUploadJob = {
  id: string;
  status: KeywordUploadStatus;
  totalKeywords: number;
  processedKeywords: number;
  savedCount?: number;
  categoryCounts?: Record<string, number>;
  errorReason?: string;
  createdAt: number;
};

const jobs = new Map<string, KeywordUploadJob>();

export function createKeywordUploadJob(id: string, totalKeywords: number): KeywordUploadJob {
  const job: KeywordUploadJob = {
    id,
    status: "processing",
    totalKeywords,
    processedKeywords: 0,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getKeywordUploadJob(id: string): KeywordUploadJob | undefined {
  return jobs.get(id);
}

export function updateKeywordUploadJob(id: string, updates: Partial<KeywordUploadJob>) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, updates);
}
