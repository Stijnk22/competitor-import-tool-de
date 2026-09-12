/**
 * Language guard
 *
 * Lightweight, dependency-free check to catch the main failure mode that
 * caused non-English target languages to be removed earlier: the AI
 * drifting partway through a longer, structured description into a
 * different language (e.g. German sliding into French/Dutch).
 *
 * This is deliberately NOT a full language classifier. It only needs to
 * answer one question well enough: "is this text predominantly the target
 * language, or did it clearly drift?" It does that by scoring how many
 * common, high-frequency function words of the target language appear,
 * relative to how many function words of a few likely drift-languages
 * appear. That's a cheap, robust signal for whole-section drift without
 * flagging every minor imperfection.
 */

// Common, high-frequency function words per language. Function words are
// used (not content words) because they're extremely frequent and highly
// language-specific — a German paragraph will be full of "und/der/die/mit",
// a French drift full of "et/le/la/avec", etc.
const FUNCTION_WORDS: Record<string, string[]> = {
  de: ["und", "der", "die", "das", "mit", "für", "ist", "sich", "auch", "aus", "dem", "den", "ein", "eine", "einen", "nicht", "sie", "wird", "oder", "durch", "bei", "zum", "zur", "auf", "im", "sind", "wie", "sowie"],
  fr: ["et", "le", "la", "les", "des", "une", "avec", "pour", "dans", "est", "vous", "votre", "sur", "aux", "ce", "cette", "qui", "que", "plus", "sans"],
  nl: ["en", "de", "het", "een", "met", "voor", "is", "van", "op", "je", "zijn", "wordt", "ook", "aan", "door", "bij", "naar", "dat", "deze", "uw"],
  en: ["the", "and", "with", "for", "this", "your", "you", "are", "that", "from", "these", "our", "will", "its", "into", "perfect", "made"],
};

function countMatches(words: string[], targetSet: Set<string>): number {
  let n = 0;
  for (const w of words) {
    if (targetSet.has(w)) n++;
  }
  return n;
}

/**
 * Returns true if `text` appears to be predominantly in the target
 * language (by ISO code, e.g. "de"). Strips HTML first so tags/attributes
 * don't skew the word counts. For very short texts it returns true (not
 * enough signal to claim drift — the title alone is checked separately by
 * being part of the combined text).
 */
export function isPredominantlyLanguage(text: string, targetIso: string): boolean {
  // English target rarely drifts; treat as always-fine to avoid needless
  // regeneration (the earlier problem was specifically non-English).
  if (targetIso === "en") return true;

  const targetWords = FUNCTION_WORDS[targetIso];
  if (!targetWords) return true; // unknown target -> don't block

  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .replace(/[^a-zàâäéèêëïîôöùûüçßñ\s]/gi, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (plain.length < 25) return true; // too short to judge reliably

  const targetSet = new Set(targetWords);
  const targetScore = countMatches(plain, targetSet);

  // Compare against the most likely drift languages for a German target.
  let maxOtherScore = 0;
  for (const [iso, words] of Object.entries(FUNCTION_WORDS)) {
    if (iso === targetIso) continue;
    const score = countMatches(plain, new Set(words));
    if (score > maxOtherScore) maxOtherScore = score;
  }

  // Predominant = the target language's function words appear clearly more
  // than any single other language's. A small margin requirement avoids
  // false alarms on short or mixed-but-mostly-correct text.
  // Also require a minimum absolute target signal, so a paragraph with
  // almost no target function words (a sign of drift) fails even if no
  // other language scores high either.
  const minTargetSignal = Math.max(3, Math.floor(plain.length / 40));
  return targetScore >= minTargetSignal && targetScore >= maxOtherScore;
}
