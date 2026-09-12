/**
 * Keyword CSV parser
 *
 * Google Keyword Planner exports aren't clean CSV: they contain a title
 * row, a date-range row, and often "summary" rows (like "All" or a
 * country name) mixed in among the real keyword data. They may also
 * start with an invisible BOM character, and some regional exports use a
 * semicolon or tab instead of a comma as the delimiter. This parser tries
 * to handle all of this robustly.
 */

export type ParsedKeywordRow = {
  keyword: string;
  avgMonthlySearches: number;
};

/**
 * Simple line parser with support for quoted values and a configurable
 * delimiter.
 */
function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Strips a leading BOM character (common in Excel/Google exports). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Strips any surrounding quotes and normalizes whitespace. */
function cleanCell(value: string | undefined): string {
  if (!value) return "";
  return value.trim().replace(/^"(.*)"$/, "$1").trim();
}

/**
 * Determines the most likely delimiter by checking which of
 * comma/semicolon/tab occurs most often in the first few lines.
 */
function detectDelimiter(lines: string[]): string {
  const candidates = [",", ";", "\t"];
  const sample = lines.slice(0, 5).join("\n");
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = sample.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * Parses a raw Keyword Planner CSV and returns only the actual keyword
 * rows (keyword + average monthly search volume).
 */
export function parseKeywordPlannerCsv(rawCsv: string): ParsedKeywordRow[] {
  const withoutBom = stripBom(rawCsv);
  const lines = withoutBom.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines);
  console.log(`[keyword-csv-parser] Detected delimiter:`, JSON.stringify(delimiter));
  console.log(`[keyword-csv-parser] Number of non-empty lines:`, lines.length);

  // Step 1: find the real header row — the first row whose first column
  // (after cleaning, case-insensitive) is "keyword".
  let headerIndex = -1;
  let headerCells: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = parseDelimitedLine(lines[i], delimiter).map(cleanCell);
    const firstCell = cells[0]?.toLowerCase() ?? "";
    if (firstCell === "keyword" || firstCell === "keywords") {
      headerIndex = i;
      headerCells = cells.map((c) => c.toLowerCase());
      break;
    }
  }
  console.log(`[keyword-csv-parser] Header row found on line:`, headerIndex);
  console.log(`[keyword-csv-parser] Header columns:`, JSON.stringify(headerCells));
  if (headerIndex === -1) return [];

  const keywordCol = 0; // always the first column
  const currencyCol = headerCells.findIndex((c) => c === "currency");
  const volumeCol = headerCells.findIndex(
    (c) =>
      c.includes("avg") &&
      c.includes("monthly") &&
      c.includes("search")
  );
  console.log(`[keyword-csv-parser] currencyCol index:`, currencyCol, `volumeCol index:`, volumeCol);

  if (volumeCol === -1) return [];

  const results: ParsedKeywordRow[] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const cells = parseDelimitedLine(lines[i], delimiter).map(cleanCell);
    const keyword = cells[keywordCol];
    if (!keyword) continue;

    // Most reliable signal for "this is a real keyword row, not a summary
    // row": a valid 3-letter currency code in the Currency column
    // (summary rows like "All" or a country name don't have this). Only
    // applied if that column actually exists.
    if (currencyCol !== -1) {
      const currencyValue = cells[currencyCol]?.toUpperCase() ?? "";
      if (!CURRENCY_CODE_PATTERN.test(currencyValue)) {
        console.log(`[keyword-csv-parser] Row ${i} skipped (no valid currency):`, JSON.stringify(cells));
        continue;
      }
    }

    const rawVolume = cells[volumeCol]?.replace(/[,.](?=\d{3})/g, "").replace(",", ".");
    const volume = rawVolume ? Math.round(parseFloat(rawVolume)) : NaN;
    if (Number.isNaN(volume)) {
      console.log(`[keyword-csv-parser] Row ${i} skipped (invalid volume):`, JSON.stringify(cells));
      continue;
    }

    results.push({ keyword, avgMonthlySearches: volume });
  }

  return results;
}
