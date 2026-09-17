/**
 * Content optimizer
 *
 * Takes a scraped product and generates:
 *  - An optimized title (own product name + SEO-descriptive title)
 *  - A fully new, unique description following the fixed format
 *    (Why You'll Love It / Perfect For / Care Instructions / FAQ)
 *  - Meta title (= title) and meta description following the fixed template
 *  - URL slug, deterministically derived from the title (no AI)
 *
 * Attribute recognition (material, style, color, silhouette) happens
 * implicitly via Claude as part of the same call — the product photos are
 * sent along so this is based on the real product, not just the
 * (possibly incomplete) competitor's text.
 *
 * Keyword library: if keyword data is available (uploaded via the
 * Keywords panel) for the chosen market + recognized product category,
 * the title is refined using the actual highest-scoring, verified
 * keywords. Without library data, the title remains "logically
 * optimized", as before.
 *
 * REPHRASE MODE: a separate entry point (generateRephrasedContent) that
 * does NOT create brand-new marketing copy, but instead takes the
 * product's EXISTING title and description and rewrites them so they keep
 * the same meaning and the same keywords, just built up differently — so
 * the result isn't a 1:1 copy (useful for listing the same product on a
 * second store without duplicate content). Images/slug/pricing handling
 * downstream stays exactly the same as normal mode.
 */

import { callClaude, parseJsonResponse, fetchImageAsBase64Block, type ClaudeContentBlock } from "./ai-client";
import { isPredominantlyLanguage } from "./language-guard";
import { LANGUAGE_DETECTION_INFO } from "./languages";
import { slugify } from "./slug";
import { SUPPORTED_LANGUAGES, type LanguageCode } from "./languages";
import { tryKeywordOptimizedTitle } from "./keyword-title-optimizer";
import type { ShopifyProductRaw } from "./scraper";

export type OptimizedContent = {
  title: string;
  slug: string;
  descriptionHtml: string;
  metaTitle: string;
  coreProductTypeEnglish: string;
  metaDescription: string;
  keyFeatures: [string, string];
  gender: string;
};

/**
 * German-market title rules. Based on real high-performing German
 * competitor titles, which follow a noticeably different convention than
 * the English ones: richer (often 4-6 attributes), "mit" is natural and
 * allowed, the core product type may appear mid-title (not forced to the
 * end), warmth/lining attributes are prominent for winter items, and
 * "orthopädisch" is an allowed, searched term for comfort footwear.
 *
 * Example target titles (this is the style to match):
 *   HERREN WINTERJACKE MIT FLEECE-FUTTER UND KAPUZE
 *   DAMEN WINTERSTIEFEL WARM GEFÜTTERT WASSERDICHT RUTSCHFESTE PROFILSOHLE
 *   DAMEN BOHO MAXIKLEID MIT V-AUSSCHNITT UND GROSSEM BLUMENMUSTER
 *   HERREN WINTERJACKE WASSER- UND WINDDICHT FLEECEFUTTER KAPUZE
 */
function buildGermanTitleRules(): string {
  return `## TITEL-FORMAT (Deutsch — WICHTIG)
Erzeuge zwei Teile:
- "firstName": ein eleganter, passender deutscher Vorname für diese Produktlinie, in Title Case (z. B. Hannah, Lena, Marie, Andreas, Matthias, Maximilian). Wähle einen Namen, dessen Stimmung zum Produkt passt. Für Herrenmode einen passenden männlichen Vornamen.
- "titleSuffix": der SEO-beschreibende Teil des Titels, in Title Case, aufgebaut als: [Geschlecht] [Produkttyp] [Merkmal] [Merkmal] [Merkmal]... — im natürlichen Stil deutscher Modetitel.

Beispiele für den GEWÜNSCHTEN Stil (genau diesen Stil nachbilden):
- "Herren Winterjacke mit Fleece-Futter und Kapuze"
- "Damen Wintersteifel Warm Gefüttert Wasserdicht Rutschfeste Profilsohle"
- "Damen Boho Maxikleid mit V-Ausschnitt und Großem Blumenmuster"
- "Herren Winterjacke Wasser- und Winddicht Fleecefutter Kapuze"
- "Damen Steppjacke mit Kapuze Blumenstickerei Winterjacke Tailliert"
- "Damen Kniehohe Stiefel mit Schnalle Reißverschluss Profilsohle"

REGELN:
- Beginne mit dem Geschlecht ("Damen" oder "Herren").
- Nenne den PRODUKTTYP früh und KORREKT — bei einer gefütterten Winter-/Outdoor-Jacke z. B. "Winterjacke", "Parka" oder "Steppjacke", NICHT "Cargojacke", wenn es keine echte Cargojacke ist. Wähle den Produkttyp genau nach dem, was das Produkt wirklich ist (Fotos + Text).
- GENAU EIN Produkttyp pro Titel — niemals zwei verschiedene Produkttypen im selben Titel nennen. Beispiel: NICHT "Steppjacke ... Bomberjacke" und NICHT "Winterjacke ... Parka" zusammen. Entscheide dich für den EINEN, am genauesten zutreffenden Produkttyp und nenne nur diesen. Der Rest des Titels sind Merkmale, keine zweiten Produktnamen.
- Nenne so viele echte, sichtbare/beschriebene Merkmale wie zutreffend — typischerweise 4 bis 6 Merkmale. Deutsche Modetitel sind merkmalreich; nenne ruhig mehrere Merkmale hintereinander (z. B. "Warm Gefüttert Wasserdicht Rutschfeste Profilsohle").
- "mit" ist erlaubt und natürlich (z. B. "mit Kapuze", "mit Fleece-Futter", "mit Reißverschluss"). Du darfst Merkmale mit "mit" und "und" verbinden ODER einfach hintereinander reihen — beides ist üblich.
- Der Produkttyp muss NICHT das letzte Wort sein (anders als im Englischen) — im Deutschen steht er oft vorne oder in der Mitte, gefolgt von Merkmalen. Das ist erwünscht.
- WÄRME/FUTTER bei Winterartikeln IMMER nennen, wenn zutreffend: "Gefüttert", "Warm Gefüttert", "Fleece-Futter", "Kunstfell", "Teddyfutter" — das ist ein zentrales, stark gesuchtes Merkmal bei Winterjacken, -mänteln und -stiefeln. Übersieh es nicht.
- "orthopädisch" ist bei Komfort-/Bequemschuhen ein erlaubter, gesuchter Begriff und darf im Titel stehen, wenn zutreffend.
- Boho-Prüfung: Prüfe, ob das Produkt echt boho/bohemian ist (fließende Silhouette + ethnischer Print wie Ikat/Paisley, oder Häkel-/Quasten-/Fransendetails). Wenn ja, nimm "Boho" als eines der Merkmale auf.
- OKTOBERFEST/TRACHTEN-PRÜFUNG: Prüfe, ob der KONKURRENT-Titel oder die -Beschreibung das Produkt ausdrücklich als Trachten-/Oktoberfest-Kleidung bezeichnet (Wörter wie "Dirndl", "Lederhose", "Trachten", "Trachtenkleid", "Trachtenhemd", "Oktoberfest", "Wiesn", "Bayerisch"). NUR wenn der Quelltext das ausdrücklich sagt, behandle es als Trachten-Produkt:
  • Verwende das korrekte, stark gesuchte Trachten-Produktwort als Kern-Produkttyp — z. B. "Dirndl" (nicht "Kleid"/"Maxikleid"), "Lederhose" (nicht "Hose"), "Trachtenkleid", "Trachtenhemd", "Trachtenbluse". "Dirndl" ist viel stärker gesucht als "Dirndlkleid" — bevorzuge "Dirndl".
  • Du darfst "Oktoberfest" als zusätzliches Merkmal in den Titel aufnehmen, wenn es passt (z. B. "Damen Dirndl Oktoberfest mit Schürze Herzausschnitt").
  • Wenn der Quelltext KEINE Trachten-/Oktoberfest-Hinweise enthält, behandle es NICHT als Trachten — auch wenn es entfernt so aussehen könnte.
- Materialangaben als Stoffbezeichnung sind im Titel erlaubt, wenn sie beschreibend/gesucht sind (z. B. "Fleece-Futter", "Strick") — anders als in den englischen Regeln. Nenne Material aber nur, wenn es echt zutrifft.
- LEDER-REGEL (immer beachten): Behandle Echtleder, Kunstleder, PU-Leder, Synthetikleder, Lederimitat und veganes Leder IMMER als veganes Leder. Verwende NIEMALS "Kunstleder", "Echtleder", "PU-Leder" oder "Lederimitat".
  • Regel 1 — Wenn "Leder" Teil des deutschen Haupt-Produktworts ist, behalte dieses zusammengesetzte Wort und setze die korrekt gebeugte Form von "vegan" direkt davor: Lederjacke → vegane Lederjacke; Ledermantel → veganer Ledermantel; Lederrock → veganer Lederrock; Lederkleid → veganes Lederkleid; Lederhose → vegane Lederhose; Lederblazer → veganer Lederblazer.
  • Regel 2 — Wenn das Haupt-Produktwort KEIN "Leder" enthält, behalte das spezifische Produktwort und füge direkt danach "aus veganem Leder" hinzu: Cowboystiefel → Cowboystiefel aus veganem Leder; Stiefeletten → Stiefeletten aus veganem Leder; Loafer → Loafer aus veganem Leder; Pumps → Pumps aus veganem Leder.
  • Regel 3 — Ersetze niemals ein spezifisches, kaufstarkes Produktwort durch ein generisches Leder-Wort. NICHT "Cowboystiefel" → "Lederstiefel", sondern "Cowboystiefel aus veganem Leder".
  • Regel 4 — Korrekte deutsche Adjektiv-Endungen: vegane Lederjacke, veganer Ledermantel, veganes Lederkleid, aus veganem Leder.
  • Regel 5 — Behalte wichtige Produkttyp-Wörter genau so, wie deutsche Käufer sie nutzen (Lederjacke, Cowboystiefel, Stiefeletten, Bikerjacke, Ledermantel, Lederrock).
  • Regel 6 — Schreibe NICHT "aus veganem Leder", wenn das Produktwort selbst schon ein Leder-Kompositum ist. Bevorzugt: "vegane Lederjacke". Vermeide: "Lederjacke aus veganem Leder".
  • Regel 7 — Für JEDE Jacke aus Leder-Optik (auch Biker-, Motorrad-, Aviator-, Racer-Stil) verwende IMMER "vegane Lederjacke" als Produkttyp. Nicht "Bikerjacke", "Motorradjacke" o. ä. — der Kern-Produkttyp einer Lederjacke ist immer "vegane Lederjacke". (Ein Stil-Merkmal wie "im Biker-Stil" darf zusätzlich als Merkmal genannt werden, aber der Produkttyp bleibt "vegane Lederjacke".)
- Wiederhole kein wichtiges Wort doppelt im titleSuffix.
- Kopiere niemals den exakten Titel des Konkurrenten — bilde eine eigene Version aus den echten Merkmalen.
- NATÜRLICHE DEUTSCHE TERMINOLOGIE (Zielgruppe 35+): Verwende natürliche deutsche Einkaufssprache. Entferne NICHT automatisch alle englischen Modebegriffe — behalte englische Begriffe, die im deutschen Modehandel bereits Standard und weit verbreitet sind, z. B.: Oversize, Slim Fit, Regular Fit, Relaxed Fit, Blazer, Trenchcoat, Sneaker, Loafer, Chelsea Boots, Hoodie, Sweatshirt, T-Shirt, Parka, Bomberjacke, Maxi, Midi, Mini, Fair Isle, Boho, Vintage, Western, Colorblock.
  Bevorzuge aber das deutsche Wort, wenn die englische Formulierung für deutsche Käufer ab 35 weniger natürlich ist — besonders bei Kern-Produkttypen und Kleidungsmerkmalen:
  • Cardigan → Strickjacke
  • Longline Cardigan / Long Strickjacke → lange Strickjacke
  • Sweater → Pullover
  • Coat → Mantel
  • Jacket → Jacke
  • Puffer Jacket → Steppjacke / Winterjacke
  • Turtleneck → Rollkragen
  • Crew Neck → Rundhalsausschnitt
  • Square Neck → Eckiger Ausschnitt
  • Sweetheart Neckline → Herzausschnitt
  • Yoke → Rundpasse
  • Layering → weglassen oder natürlich auf Deutsch umschreiben
  • Shacket → Hemdjacke (wenn dieser Produkttyp korrekt ist)
  WICHTIG: nicht blind übersetzen. Wenn ein englischer Begriff im deutschen Handel gängig ist und für Käufer ab 35 natürlich klingt, behalte ihn. Bei langen Strickjacken bevorzuge "lange Strickjacke" statt "Longline Cardigan" oder "Long Strickjacke".
- GÄNGIGSTES PRODUKTTYP-WORT WÄHLEN (wichtig für die Auffindbarkeit): Wähle für den Produkttyp das gängigste, am häufigsten gesuchte deutsche Wort. Wenn das genaueste Wort ein spezifischer, aber selten gesuchter Begriff ist und es ein breiteres, viel häufiger gesuchtes Wort gibt, das trotzdem korrekt ist, verwende das breitere Wort — ABER behalte immer die unterscheidenden Merkmale davor.
  Beispiele:
  • "Kniehohe Schnürstiefel" → "Kniehohe Stiefel" (Schnürstiefel ist selten gesucht; "Stiefel" ist viel gängiger — "Kniehohe" bleibt)
  • "Steppmantel" → "Wintermantel" (falls zutreffend; gängiger gesucht)
  • "Bikerjacke" (aus Leder-Optik) → "vegane Lederjacke" (gemäß LEDER-REGEL 7)
  Aber: wenn das spezifische Wort SELBST schon ein starker, häufig gesuchter Begriff ist (z. B. "Rollkragenpullover", "Maxikleid", "Trenchcoat", "Steppjacke"), behalte es — mache es NICHT breiter.
  Niemals zu einem bedeutungslosen Oberbegriff verallgemeinern ("Schuhe", "Kleid", "Oberteil", "Damenmode"), und niemals ein unterscheidendes Merkmal (Kniehohe, Maxi, Oversize, Gefüttert) weglassen — du tauschst nur das Produkttyp-WORT selbst, nie die beschreibenden Merkmale.
- "coreProductTypeEnglish": das einzelne Kern-Produktnomen, IMMER AUF ENGLISCH (nur intern, z. B. "Jacket", "Boots", "Dress", "Coat") — bestimme es selbst aus dem, was das Produkt wirklich ist.`;
}

function buildSystemPrompt(languageName: string): string {
  // German market uses its own title convention (see buildGermanTitleRules).
  // All other languages keep the original English-derived title format.
  const titleSection =
    languageName === "German"
      ? buildGermanTitleRules()
      : `## TITLE FORMAT
Generate two parts, both in Title Case (capitalize the first letter of every significant word, including each part of hyphenated words — e.g. "Relaxed-Fit", "Round-Toe", "A-Line" — never write in ALL CAPS/full uppercase):
- "firstName": an elegant, fitting first name for this product line, in Title Case (e.g. Sophie, Aria, Phoebe, Rosie, Sienna). Choose a name whose feel matches the product's style. For menswear, choose a fitting name in the same convention.
- "titleSuffix": the SEO-descriptive part of the title, in Title Case and in ${languageName}, formatted as: [Gender]'s [Attribute] [Attribute] [Attribute]... [Core Product Type] (using the natural word order and grammar of ${languageName} — don't force English word order).
  - Include as many distinctive, genuinely visible/described attributes as accurately apply (style detail, silhouette, closure type, neckline, sleeve length, pattern, etc.) — this is typically 3 to 5 attributes, sometimes more for a highly detailed product, but never invent an attribute that isn't actually visible or described. Prioritize the most distinctive and searchable attributes if there are many candidates.
  - IMPORTANT — Boho check: always specifically check whether the product is genuinely boho/bohemian-style, since "Boho" is a high-value, frequently-searched term. It IS boho if it clearly shows a combination of things like: a relaxed/flowy silhouette AND an ethnic-inspired print (ikat, paisley, tribal, batik) or crochet/embroidery/tassel/fringe detailing. If so, use "Boho" as ONE of your 3-5 attribute choices — meaning it REPLACES one of the more granular attributes that signals the boho look (e.g. replace the specific print name or trim detail with "Boho" instead), it does not get added on top of them. Never stack both the specific detail and "Boho" together, and never add "Boho" if the product doesn't genuinely show these cues — this must be as accurate as every other attribute, not a default guess.
  - NEVER include fabric or material descriptors in the title (no "Cotton", "Leather", "Suede", "Velvet", "Tweed", "Wool", "Linen", "Knit" used as a material reference, etc.) — material information belongs in the description only, not the title. Style/construction words that aren't materials themselves are fine (e.g. "Chunky Knit" describing a knit STYLE is borderline — prefer non-material style words like "Cable-Knit pattern" only if genuinely needed; when in doubt, leave material-sounding words out of the title).
  - The core product noun is normally the LAST word(s) of titleSuffix. It may be a single word ("Jumper", "Sandals") or a natural two-word compound when that's the accurate term ("Blazer Jacket", "Shirt Dress").
  - The core product noun is always the LAST word(s) of titleSuffix — never place a trailing detail after it (e.g. never "...Shirt Dress with Pockets" or "...Trousers with Belt"). If a feature like pockets is worth mentioning, it belongs in the description, not the title.
  - Use hyphens for compound style modifiers, matching natural fashion terminology (e.g. "Round-Toe", "Slip-On", "A-Line", "Button-Down", "Relaxed-Fit").
  - Never repeat the same significant word twice within titleSuffix, even as part of two different compound attributes (e.g. never combine "Criss-Cross Strap" with "Ankle-Strap" in the same title — "Strap" would then appear twice; pick only one of them, or rephrase one to avoid the repeated word). Before finalizing, check titleSuffix word-by-word for any accidental repetition.
  - Total title length (firstName + titleSuffix combined) should stay roughly under 80 characters where possible, but a fully accurate, attribute-rich title takes priority over hitting an exact character count.
- Never copy the competitor's exact title wording verbatim — always construct your own version based on the product's real attributes.
- "coreProductTypeEnglish": the single core product noun, ALWAYS IN ENGLISH regardless of the target language above, e.g. "Dress", "Heels", "Blazer", "Jumper", "Sandals". This is used internally for Shopify's product category system and is never shown to customers — do not use the (possibly messy or inaccurate) product type/category text supplied by the source data; determine this yourself from what the product actually is, based on the images and description.`;

  return `You are an expert Shopify product copywriter and SEO specialist for a fashion dropshipping brand. You are shown a competitor's product photos, title, and description, and you produce fully original, optimized content for the same physical product to be listed in a different store.

## LANGUAGE — CRITICAL, READ CAREFULLY
Write EVERY field entirely in ${languageName}: titleSuffix, descriptionHtml, keyFeature1, keyFeature2, and metaDescription. This is a hard requirement.
- Use correct, natural, native-level ${languageName} throughout — correct grammar, spelling, capitalization conventions, and natural fashion-retail phrasing for that language.
- ABSOLUTELY DO NOT drift into any other language at any point. A very common failure is starting correctly in ${languageName} and then switching mid-description into another language (e.g. English, French, or Dutch) — this is completely unacceptable. Every single sentence, in every section (opening paragraph, bullet points, Care Instructions, FAQ), must be in ${languageName}.
- Before you finish, re-read your entire output and verify that 100% of it — every sentence of the description, the title, and the meta description — is written in ${languageName}. If any part is not, rewrite it in ${languageName} before responding.
- The ONLY exception is the "coreProductTypeEnglish" field, which is always in English by design (it's internal, never shown to customers).

## TERMINOLOGY (applies everywhere — title, description, alt text, everything)
- Whenever referring to a leather-look material anywhere (title or description), always call it "Vegan Leather" — never "Leather", "Faux Leather", "Faux-Leather", "PU Leather", "Synthetic Leather", or "Leatherette". Use "Vegan Leather" consistently, even in a compound like "Vegan Leather Trim". (In German: "Kunstleder".)

${titleSection}

## DESCRIPTION FORMAT (descriptionHtml)
Follow this exact structure, output as raw HTML (no markdown), in ${languageName}.
CRITICAL: the SECTION HEADINGS must also be in ${languageName} — do NOT leave them in English. Use the natural ${languageName} translation of each heading. For German specifically, use exactly these headings: "Warum Sie es lieben werden", "Perfekt für", "Pflegehinweise", "Häufig gestellte Fragen".

1. Opening paragraph, no heading: "<p>[Full product description reworded as natural flowing prose — don't just repeat titleSuffix verbatim, rephrase it naturally] is/are your go-to choice for [use case/occasion]. [One sentence on construction/style with 2-3 key attributes], [it's/these are] perfect for [gender] who [want/seek benefit].</p>"

2. "Why You'll Love It" heading, translated into ${languageName} (German: "Warum Sie es lieben werden"):
"<p><strong>[heading in ${languageName}]</strong></p><ul><li><strong>[Feature Name, 2-4 words]:</strong> [one benefit sentence].</li>...</ul>"
Exactly 3 <li> items, no more, no fewer.

3. "Perfect For" heading, translated into ${languageName} (German: "Perfekt für"):
"<p><strong>[heading in ${languageName}]</strong></p><p>[one flowing paragraph, exactly 4 styling/usage suggestions, comma-separated, last one preceded by the ${languageName} word for "or"].</p>"

4. "Care Instructions" heading, translated into ${languageName} (German: "Pflegehinweise"):
"<p><strong>[heading in ${languageName}]</strong></p><ul><li>...</li>...</ul>"
3-4 short imperative-sentence bullets, appropriate to the actual material of THIS product.

5. FAQ, with the heading translated into ${languageName} (German: "Häufig gestellte Fragen"):
"<h2><strong>[FAQ heading in ${languageName}]</strong></h2><p><strong>[Question]?</strong><br>[Answer sentence].</p>..."
3-4 question/answer pairs, covering whichever are most relevant: closure/fastening mechanism, available sizes/fit range, a specific silhouette/shape detail, styling/occasion suggestions.

## RULES
- Never copy exact phrases or sentences from the competitor's source description — always rewrite fully in your own original words, even when describing the same physical attribute.
- Never invent materials, features, or claims that aren't visible in the photos or mentioned in the source description.
- Tone: warm, confident, professional. No emoji. No excessive capitalization outside the title fields.
- Base the FAQ and Care Instructions on the specific product shown, not generic filler.

## META DESCRIPTION FORMAT
Generate "metaDescription" in ${languageName}, following exactly this template:
"Shop the [firstName] [titleSuffix]. A [short, natural, simplified core product phrase — e.g. "tailored blazer", "flowy maxi dress", "chunky knit jumper"] with [feature 1], [feature 2] and [feature 3] for [use-case/occasion 1], [use-case/occasion 2] and [use-case/occasion 3] looks."
Example: "Shop the Holt Men's Structured Textured Slim-Fit Blazer Jacket with Notch Lapel. A tailored blazer with a textured finish, sharp lapels and smart fit for office, formal and smart-casual looks."
- The first sentence always starts with "Shop the" followed by the exact full title (firstName + titleSuffix) and a period.
- The second sentence always starts with "A" and names exactly 3 features and exactly 3 use-cases/occasions, ending in the word "looks."
- Base the 3 features and 3 occasions on what's actually visible/described for this product — never invent details not supported by the images or source text.
- Keep the whole thing natural and concise — roughly 180-220 characters total is the right range, don't pad artificially to reach it and don't cut a feature/occasion short to stay under it.

## OUTPUT
Respond with ONLY a valid JSON object, no markdown code fences, no preamble, no explanation. Schema:
{
  "visualAnalysis": string,
  "firstName": string,
  "titleSuffix": string,
  "coreProductTypeEnglish": string,
  "gender": string, // "Women" or "Men", in English regardless of target language — used internally
  "descriptionHtml": string,
  "keyFeature1": string,
  "keyFeature2": string,
  "metaDescription": string
}

IMPORTANT — fill in "visualAnalysis" FIRST, before anything else, and base the title and all other fields strictly on it. This is the single most important step for getting the product right.

In "visualAnalysis" (in English, internal only — never shown to customers), do the following, in order:

STEP A — Read the competitor's source text as your primary evidence for WHAT the product is.
The competitor physically has this product and usually names it correctly. If the source title/description states the product type, material, or a specific feature, TRUST THAT over your own guess from the photos. The photos are for confirming and adding visible detail, not for overriding what the source explicitly says. Only disagree with the source text if the photos clearly contradict it.

STEP B — Then look carefully at ALL the provided photos (not just the first one — key details like an open heel, a collar shape, or a closure often only show on a later/detail photo) and describe what you ACTUALLY see, being precise about the details that are easy to get wrong:
- The exact product type. Is a shoe closed at the heel (ballerina/flat) or open at the heel with a strap (slingback)? Is a jacket a genuine cargo jacket, or a padded/quilted winter jacket/parka? Name what it really is.
- The neckline/collar precisely. CRITICAL: a V-shape created merely by an OPEN button placket is NOT a real V-neck — it is a Henley/button neckline (Henley-Ausschnitt / Knopfausschnitt). Do not invent a folded collar (Umlegekragen) where there is only a button opening. A stand-up collar (Stehkragen, Mao-style) is different from a folded-over shirt collar (Umlegekragen).
- The pattern precisely. A checked/tartan weave (Karo) is completely different from diamond-shaped quilting/stitching (Raute / Rautensteppung). Do not call quilting "Karo".

STEP C — CERTAINTY RULE (THE MOST IMPORTANT RULE — most errors happen here):
OVERRIDING PRINCIPLE: If you are not 100% certain about a specific feature, DO NOT put it in the title at all. Leave it out. An omitted feature is never wrong; a guessed feature makes the whole title untrustworthy. Never guess a SPECIFIC sub-type of anything — if you can only be sure of the general thing, either use the neutral general word or omit it entirely. Specifically:
- SPECIFIC SUB-TYPES — only name the exact sub-type if you are sure; otherwise use the neutral word or leave it out:
  • Lining: a soft fluffy teddy/fleece lining (Teddyfutter/Fellfutter) is NOT the same as a quilted/padded lining (Steppfutter). If you are not sure which it is, just write "gefüttert" (or leave lining out) — never guess the type.
  • Knit: chunky knit (Grobstrick) vs fine knit (Feinstrick) vs plain — if unsure, use "Strick".
  • Pattern: checked/tartan (Karo) vs diamond quilting (Raute/Rautensteppung) — never mix these up; if unsure, omit.
  • Hem/sleeve/collar sub-types likewise: use the neutral term or omit when unsure.
- NEVER infer a material (satin, silk, wool) purely from sheen or texture in a photo — only state a material if the source text confirms it. "Glossy-looking" is not "Satin".
- Do NOT claim a colour effect like "Ombré"/gradient AT ALL unless the source TEXT explicitly uses that word — folds, lighting and sheer fabric are not an ombré.
- LAYERED OUTFITS: describe only the product being sold. A collar, cuff or hem from a garment worn underneath (e.g. a blouse under a knit jumper) is NOT a feature of this product — never attribute it to the product.
- A title with 4 features you are SURE of is FAR better than 6 where 2 are guessed. When in any doubt, leave the uncertain feature OUT.

STEP D — WORD CHOICE: prefer the most common, most-searched German term when two are correct (e.g. "Dirndl" over "Dirndlkleid", "Reverskragen" over "Kerbkragen"). Ensure correct German adjective inflection ("Runde Zehenpartie", not "Runder Zehenpartie").

Only after completing A-D, choose the product type and attributes for the title strictly according to what you established — never contradict your own visualAnalysis. Before finalizing the titleSuffix, re-check it once: does every single attribute in it appear in your visualAnalysis as something you were sure of? If any attribute was a guess or isn't supported by your analysis, remove it or replace it with a neutral term.`;
}

type ClaudeOutput = {
  visualAnalysis?: string;
  firstName: string;
  titleSuffix: string;
  coreProductTypeEnglish: string;
  gender: string;
  descriptionHtml: string;
  keyFeature1: string;
  keyFeature2: string;
  metaDescription: string;
};

function findRepeatedSignificantWord(titleSuffix: string): string | null {
  const STOP_WORDS = new Set(["with", "and", "the", "for"]);
  const words = titleSuffix
    .toLowerCase()
    .split(/[\s-]+/)
    .map((w) => w.replace(/['\u2019]s$/, ""))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const seen = new Set<string>();
  for (const word of words) {
    if (seen.has(word)) return word;
    seen.add(word);
  }
  return null;
}

function getSizeRange(product: ShopifyProductRaw): string | null {
  const sizeOption = product.options.find((o) => o.name.toLowerCase() === "size");
  if (!sizeOption || sizeOption.values.length === 0) return null;
  const values = sizeOption.values;
  if (values.length === 1) return values[0];
  return `${values[0]}\u2013${values[values.length - 1]}`;
}

function truncateMetaDescription(text: string, maxLength = 230): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, lastSpace)}...`;
}

function enforceTerminology(titleSuffix: string, languageName: string = "English"): string {
  let result = titleSuffix;

  const isGerman = languageName === "German";

  // Leather -> Vegan Leather. English markets use "Vegan Leather"; the
  // German market uses "veganem Leder".
  if (!isGerman) {
    result = result.replace(/\b(Faux[-\s]|PU\s|Synthetic\s)?Leather(ette)?\b/gi, "Vegan Leather");
    result = result.replace(/\bVegan\s+Vegan\s+Leather\b/gi, "Vegan Leather");
  } else {
    // German leather rule (see the 7 rules in the prompt). Safety net that
    // enforces them regardless of what the model produced.
    //
    // Rule 7 first: any leather-style jacket variant (Biker/Motorrad/etc.
    // followed by an explicit leather material) -> "vegane Lederjacke".
    // We only convert when a leather material is explicitly present, so a
    // non-leather bomber/biker jacket is left alone.
    result = result.replace(
      /\b(?:Biker|Motorrad|Aviator|Racer|Fliegerin?)?jacke\s+aus\s+(?:Kunst|Echt|PU[-\s]?|Synthetik|Öko|veganem\s+)?Leder\b/gi,
      "vegane Lederjacke"
    );

    // Gender of each "Leder…" compound noun, for the correct "vegan"
    // ending: die Jacke -> vegane, der Mantel -> veganer, das Kleid ->
    // veganes, etc.
    const lederCompoundGender: Record<string, "e" | "er" | "es"> = {
      jacke: "e", jacken: "e", weste: "e", westen: "e", hose: "e", hosen: "e",
      bluse: "e", tasche: "e", tunika: "e", // die -> vegane
      mantel: "er", rock: "er", blazer: "er", // der -> veganer
      kleid: "es", // das -> veganes
    };

    // Rule 1 + 4 + 6: a "Leder<garment>" compound (incl. Kunst/Echt/PU
    // prefixes, which we drop) -> "<inflected vegan> Leder<garment>".
    result = result.replace(
      /\b(?:Kunst|Echt|PU[-\s]?|Synthetik|Öko)?Leder(jacke|jacken|mantel|rock|blazer|kleid|hose|hosen|weste|westen|bluse|tasche|tunika)\b/gi,
      (_m, garment: string) => {
        const ending = lederCompoundGender[garment.toLowerCase()] ?? "e";
        // Keep the compound as one word with a lowercase garment part
        // (e.g. "Lederjacke", not "LederJacke").
        const noun = "Leder" + garment.toLowerCase();
        return `vegan${ending} ${noun}`;
      }
    );
    // Avoid "vegane vegane Lederjacke" if "vegan" was already present.
    result = result.replace(/\bvegan(?:e|er|es)\s+vegan(e|er|es)\s+(Leder\w+)\b/gi, "vegan$1 $2");

    // Rule 2/3: a bare leather-material reference (Kunstleder, PU-Leder,
    // Lederimitat, or a standalone "Leder") -> "veganem Leder" (used as
    // "... aus veganem Leder"). Only applies to material words, not the
    // garment compounds handled above (those are already done).
    result = result
      .replace(/\b(Kunst|Echt|PU[-\s]?|Synthetik|Öko)\s?Leder(imitat|optik)?\b/gi, "veganem Leder")
      .replace(/\bLederimitat\b/gi, "veganem Leder")
      .replace(/\b(?<!vegan(?:es|em|er|e)\s)Leder\b/gi, "veganem Leder");
    // Collapse accidental doubling.
    result = result.replace(/\bvegan(?:es|em|er|e)\s+veganem\s+Leder\b/gi, "veganem Leder");
    result = result.replace(/\bveganem\s+veganem\s+Leder\b/gi, "veganem Leder");
  }

  // The following are English-market rules that do NOT apply to German:
  //  - "Orthopedic" is banned in English, but "orthopädisch" is an
  //    allowed, searched term in German titles.
  //  - the trailing "with X" strip targets English "with"; German titles
  //    deliberately allow "mit ...".
  //  - the boho-signal-word strip targets English words (Ikat, Tassel-Tie,
  //    etc.); German boho titles keep their own phrasing.
  if (!isGerman) {
    result = result.replace(/\bOrthopedic\b\s*/gi, "").replace(/\s{2,}/g, " ").trim();
    result = result.replace(/\s+with\s+[A-Za-z][A-Za-z\s-]*$/i, "").trim();

    if (/\bBoho\b/i.test(result)) {
      result = result
        .replace(/\b(Ikat|Paisley|Tribal|Batik)(\s+Print)?\s+/i, "")
        .replace(/\b(Crochet|Embroidered|Tassel-?Tie|Tasseled|Fringe|Fringed)\s+/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
  }

  // German safety net: the AI occasionally puts TWO different product
  // types in one title (e.g. "Steppjacke ... Bomberjacke"). A title
  // should name exactly one. If two known jacket-types (or two known
  // boot/shoe-types) appear, keep the FIRST occurrence and drop the
  // later duplicate type, leaving the rest of the title intact.
  if (isGerman) {
    const jacketTypes = [
      "Steppjacke", "Bomberjacke", "Winterjacke", "Übergangsjacke", "Parka",
      "Daunenjacke", "Wollmantel", "Wintermantel", "Kurzmantel", "Langmantel",
      "Trenchcoat", "Fleecejacke", "Softshelljacke", "Regenjacke", "Lederjacke",
      "Jeansjacke", "Cabanjacke", "Dufflecoat", "Kapuzenjacke", "Bikerjacke",
      "Fliegerjacke", "Teddymantel", "Steppmantel", "Wickelmantel", "Mantel",
    ];
    const shoeTypes = [
      "Stiefeletten", "Stiefel", "Ankle Boots", "Chelsea Boots", "Winterstiefel",
      "Overknee Stiefel", "Cowboyboots", "Bikerboots", "Combat Boots", "Schnürboots",
      "Reiterstiefel", "Plateaustiefel", "Pumps", "High Heels", "Loafer",
      "Ballerinas", "Sneaker", "Mokassins", "Slipper",
    ];
    const dropSecondType = (typeList: string[]) => {
      // Find, in title order, the positions where any listed type appears.
      const found: { type: string; index: number }[] = [];
      for (const t of typeList) {
        const idx = result.toLowerCase().indexOf(t.toLowerCase());
        if (idx !== -1) found.push({ type: t, index: idx });
      }
      if (found.length < 2) return;
      // Sort by position; keep the first, remove any later distinct type.
      found.sort((a, b) => a.index - b.index);
      const keep = found[0].type;
      for (const f of found) {
        if (f.type.toLowerCase() === keep.toLowerCase()) continue;
        // Remove the duplicate type word (whole word), then tidy spaces.
        const re = new RegExp(`\\s*\\b${f.type.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
        result = result.replace(re, " ").replace(/\s{2,}/g, " ").trim();
      }
    };
    dropSecondType(jacketTypes);
    dropSecondType(shoeTypes);
  }

  return result;
}

/**
 * Dedicated product-recognition call. Runs BEFORE the main generation and
 * does only one job: look hard at the photos + source text and establish,
 * in plain English, exactly what the product is and what its features
 * actually are — with full focus, not as a side task of writing the title.
 *
 * The result is fed into the main generation as established facts the
 * title must respect. This exists because, when the model does recognition
 * and title-writing in one call, it tends to make "hasty" precision
 * errors (calling a riding-style boot a "Reitstiefel", a button placket an
 * "offene Front", etc.). A separate, focused pass reduces those.
 *
 * Best-effort: if it fails, we return null and the main generation still
 * runs on its own (just without the extra guidance).
 */
async function recognizeProduct(
  product: ShopifyProductRaw,
  strippedDescription: string,
  imageBlocks: ClaudeContentBlock[]
): Promise<string | null> {
  if (imageBlocks.length === 0) return null;

  const RECOGNITION_SYSTEM = `You are a meticulous fashion product analyst. Your ONLY task is to identify, as accurately as possible, what a single clothing/footwear product is and what its real features are — you do NOT write any marketing copy or title.

Use the competitor's source text as PRIMARY evidence for the product type and any stated material (they sell the item and usually name it correctly), and use ALL the photos to confirm and add visible detail.

Be strict and literal. Follow these rules:
- Distinguish STYLE from FUNCTION: a boot that merely looks like a riding boot is NOT a "riding boot" unless it's genuinely for riding — describe it by its actual form (e.g. "knee-high boots in a riding-boot style"). Same for "cargo", "utility", etc. — only if genuinely that.
- TRACHTEN/OKTOBERFEST: if the source title/description explicitly calls the product Dirndl, Lederhose, Trachten, Trachtenkleid, Oktoberfest, Wiesn or Bavarian traditional wear, note it as a traditional Trachten product and give the specific traditional product type (Dirndl, Lederhose, Trachtenkleid, Trachtenhemd) — not a generic one (Kleid, Hose). Only do this if the source text says so; do not infer Trachten from looks alone.
- LAYERED OUTFITS: the model is often styled with other garments (a blouse under a jumper, a shirt under a jacket, a top under a cardigan). Describe ONLY the product being sold. A collar, cuff, or hem belonging to a garment worn UNDERNEATH is NOT a feature of this product — do not attribute it. If you see a stand-up/shirt collar peeking out but the main product is a knit jumper, that collar belongs to a blouse underneath, not the jumper.
- Name each feature by the correct part: a corset-like BODICE is the top/bodice, not the waist. A metal horsebit ornament is a decorative detail, not a buckle/closure. A button placket is a button closure, not an "open front".
- CERTAINTY (most important): If you are not 100% sure of a specific feature, do NOT state it — mark it under "uncertainOrAbsent" instead. Never guess a SPECIFIC sub-type. In particular: a soft teddy/fleece lining (Teddyfutter) is not a quilted lining (Steppfutter) — if unsure which, only say "lined/gefüttert". Chunky knit (Grobstrick) vs fine knit — if unsure say just "knit". Checked (Karo) vs diamond quilting (Raute) — never confuse. Never infer material from sheen. Don't claim a gradient/ombré, a flounce, or a chunky knit unless clearly so. When unsure, prefer the neutral term or leave it out entirely — an omitted feature is never wrong, a guessed one is.
- A neckline V-shape caused only by an open button placket is a button/Henley neckline, NOT a V-neck. Don't invent a collar where there's only a button opening.

Respond with ONLY valid JSON, no markdown:
{
  "productType": string,        // what it actually is, plain English, e.g. "knee-high boots (riding-boot style)"
  "confirmedFeatures": string[],// features you are genuinely sure of, each named by the correct part
  "uncertainOrAbsent": string[] // things that might look present but you are NOT sure of, or explicitly are not there (so the copywriter avoids claiming them)
}`;

  try {
    const responseText = await callClaude({
      system: RECOGNITION_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: [
                `Competitor's original title: ${product.title}`,
                `Competitor's description (source): ${strippedDescription}`,
                `Source category hint: ${product.product_type}`,
                ``,
                `Identify the product and its real features according to your rules. Respond with the JSON only.`,
              ].join("\n"),
            },
          ],
        },
      ],
      maxTokens: 1000,
    });

    const parsed = parseJsonResponse<{
      productType?: string;
      confirmedFeatures?: string[];
      uncertainOrAbsent?: string[];
    }>(responseText);

    const lines: string[] = [];
    if (parsed.productType) lines.push(`Product type: ${parsed.productType}`);
    if (parsed.confirmedFeatures?.length) lines.push(`Confirmed features: ${parsed.confirmedFeatures.join("; ")}`);
    if (parsed.uncertainOrAbsent?.length) lines.push(`Do NOT claim (uncertain or absent): ${parsed.uncertainOrAbsent.join("; ")}`);

    if (lines.length === 0) return null;
    console.log(`[content-optimizer] Product recognition:\n${lines.join("\n")}`);
    return lines.join("\n");
  } catch (err) {
    console.warn(`[content-optimizer] Recognition call failed, continuing without it:`, err);
    return null;
  }
}

export async function generateOptimizedContent(
  product: ShopifyProductRaw,
  storeName: string,
  language: LanguageCode
): Promise<OptimizedContent> {
  const strippedDescription = product.body_html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sortedImages = [...product.images].sort((a, b) => a.position - b.position);
  // Analyze up to 8 images (was 3): key identifying details — an open
  // heel, a specific collar type, quilting pattern — are often only
  // clearly visible on later/detail photos, so more images means the AI is
  // far less likely to misread the product type or a feature.
  const imageUrls = sortedImages.slice(0, 8).map((img) => img.src);
  const imageBlocksRaw = await Promise.all(imageUrls.map(fetchImageAsBase64Block));
  const imageBlocks = imageBlocksRaw.filter((b): b is ClaudeContentBlock => b !== null);

  const optionsText = product.options.map((o) => `${o.name}: ${o.values.join(", ")}`).join(" | ");
  const sizeRange = getSizeRange(product);
  const languageName = SUPPORTED_LANGUAGES[language];

  // Dedicated recognition pass first (best-effort): establishes what the
  // product actually is and which features are confirmed vs. must-not-be-
  // claimed, so the title generation works from verified facts instead of
  // guessing while also writing copy.
  const recognition = await recognizeProduct(product, strippedDescription, imageBlocks);
  const recognitionBlock = recognition
    ? `\n\nVERIFIED PRODUCT ANALYSIS (from a dedicated recognition pass — treat this as established fact; the title and description MUST match it, and must NOT claim anything listed under "Do NOT claim"):\n${recognition}`
    : "";

  const userContent: ClaudeContentBlock[] = [
    ...imageBlocks,
    {
      type: "text",
      text: [
        `Competitor's original product title (PRIMARY evidence for what this product is — the competitor sells it and usually names it correctly; trust this for the product type and any material/feature it states, unless the photos clearly contradict it): ${product.title}`,
        `Competitor's original description (source — for factual details like product type, material, and features; do NOT copy its wording): ${strippedDescription}`,
        `Product type (source category — a hint, may be messy): ${product.product_type}`,
        `Options: ${optionsText}`,
        `Size range: ${sizeRange ?? "not applicable"}`,
        `Store name: ${storeName}`,
        recognitionBlock,
        ``,
        `Work through visualAnalysis steps A-D first (source text as primary evidence, then all photos, then the certainty rule, then word choice), then generate the optimized content according to the schema above, entirely in ${languageName}.`,
      ].join("\n"),
    },
  ];

  // Generate, then verify the output is actually in the target language.
  // The earlier reason non-English languages were removed was mid-content
  // language drift; this safety net catches it and regenerates once. The
  // check runs on the combined title + description + meta, and only ever
  // triggers a retry for non-English targets (English never drifts, and
  // isPredominantlyLanguage returns true for "en" so no retry happens).
  const targetIso = LANGUAGE_DETECTION_INFO[language]?.iso ?? "en";

  async function generateOnce(): Promise<ClaudeOutput> {
    const responseText = await callClaude({
      system: buildSystemPrompt(languageName),
      messages: [{ role: "user", content: userContent }],
      maxTokens: 7000,
    });
    return parseJsonResponse<ClaudeOutput>(responseText);
  }

  // Wraps generateOnce with one retry specifically for the case where the
  // model's JSON came back unparseable — almost always because the
  // response was cut off mid-text when it ran long (more likely for
  // German, whose compound words make descriptions longer). A single
  // clean retry resolves this in practice; if it still fails, the original
  // error is thrown so the item is reported as failed rather than
  // silently producing a broken product.
  async function generateOnceWithJsonRetry(): Promise<ClaudeOutput> {
    try {
      return await generateOnce();
    } catch (err) {
      console.warn(
        `[content-optimizer] Could not parse the model response as JSON (likely truncated) — retrying once.`
      );
      return await generateOnce();
    }
  }

  let parsed = await generateOnceWithJsonRetry();

  // Combine the customer-facing text fields and check the language.
  const combinedForCheck = `${parsed.titleSuffix} ${parsed.descriptionHtml} ${parsed.metaDescription}`;
  if (!isPredominantlyLanguage(combinedForCheck, targetIso)) {
    console.warn(
      `[content-optimizer] Output did not appear to be predominantly ${languageName} — regenerating once (language-drift safety net).`
    );
    const retry = await generateOnceWithJsonRetry();
    const retryCombined = `${retry.titleSuffix} ${retry.descriptionHtml} ${retry.metaDescription}`;
    // Use the retry if it passes; if it also fails, keep the retry anyway
    // (no worse than before) but log clearly so it can be caught on the
    // Draft review before going live.
    if (isPredominantlyLanguage(retryCombined, targetIso)) {
      console.log(`[content-optimizer] Regeneration produced correct ${languageName}.`);
      parsed = retry;
    } else {
      console.error(
        `[content-optimizer] WARNING: regeneration STILL did not appear predominantly ${languageName}. Using it, but review this product manually before publishing.`
      );
      parsed = retry;
    }
  }

  parsed.titleSuffix = enforceTerminology(parsed.titleSuffix, languageName);

  const duplicateWord = findRepeatedSignificantWord(parsed.titleSuffix);
  if (duplicateWord) {
    console.warn(
      `[content-optimizer] WAARSCHUWING: het woord "${duplicateWord}" komt meer dan 1x voor in de titel "${parsed.titleSuffix}" — controleer dit product handmatig.`
    );
  }

  let titleSuffix = parsed.titleSuffix;
  try {
    const keywordResult = await tryKeywordOptimizedTitle(
      language,
      parsed.coreProductTypeEnglish,
      parsed.gender,
      imageUrls,
      titleSuffix,
      product.title,
      strippedDescription
    );
    if (keywordResult) {
      titleSuffix = keywordResult.titleSuffix;
    }
  } catch {
    // Never let the whole import fail over this part.
  }

  titleSuffix = enforceTerminology(titleSuffix, languageName);

  const title = `${parsed.firstName} | ${titleSuffix}`;
  const slug = slugify(titleSuffix);

  const descriptionHtml = parsed.descriptionHtml.replace(
    /<h2>\s*(<strong>)?\s*(Frequently Asked Questions|Häufig gestellte Fragen)\s*(<\/strong>)?\s*<\/h2>/i,
    "<h2><strong>$2</strong></h2>"
  );

  return {
    title,
    slug,
    descriptionHtml,
    metaTitle: title,
    coreProductTypeEnglish: parsed.coreProductTypeEnglish,
    metaDescription: truncateMetaDescription(parsed.metaDescription),
    keyFeatures: [parsed.keyFeature1, parsed.keyFeature2],
    gender: parsed.gender,
  };
}

// ============================================================================
// REPHRASE MODE
// ============================================================================

/**
 * System prompt for rephrase mode. Unlike the normal optimizer (which
 * writes brand-new marketing copy), this deliberately KEEPS the existing
 * title and description's meaning, structure, and — crucially — the same
 * keywords, and only rewords them so the result is not a 1:1 copy.
 */
function buildRephraseSystemPrompt(languageName: string): string {
  return `You are an expert Shopify product copywriter. You are given an EXISTING product's title and description (which are already good). Your job is NOT to write brand-new copy from scratch, and NOT to change what the product is — it is to REPHRASE the existing title and description so the result carries the same meaning and keeps the same keywords, but is worded and structured differently enough that it is clearly not a 1:1 copy of the original.

## LANGUAGE
Write everything in ${languageName} (spelling conventions specifically — e.g. "Colour" vs "Color" — must match ${languageName}).

## CORE PRINCIPLE — REPHRASE, DON'T REINVENT
- Keep the SAME meaning, the SAME product attributes, and the SAME important keywords as the original. Do not drop keywords, and do not add new product claims/features that aren't in the original.
- You MAY use a few different (synonymous) words and, more importantly, a different sentence structure / word order / ordering of points, so the text reads as a genuinely different write-up of the same product.
- The goal: someone comparing the two listings sees the same product with the same key terms, but not identical sentences. Never output a sentence word-for-word identical to the original.

## TITLE
- Keep the SAME keywords/attributes and the SAME core product type as the original title, but rebuild the order/structure so it is not identical (e.g. reorder the attributes, or swap a word for a close synonym while keeping the key search terms intact).
- Same format as a normal product title: "firstName" (an elegant first name for the line, Title Case) + "titleSuffix" ([Gender]'s [Attributes...] [Core Product Type], Title Case).
- Keep the core product noun as the LAST word(s) of titleSuffix; never put a trailing detail after it.
- Never repeat the same significant word twice within titleSuffix.

## TERMINOLOGY (still applies)
- Never use "Orthopedic" anywhere.
- Always call any leather-look material "Vegan Leather" (never "Leather", "Faux Leather", "PU Leather", etc.).

## DESCRIPTION (descriptionHtml)
- Rephrase the existing description into your own wording, keeping the same information and keywords. Output raw HTML (no markdown).
- Preserve the same overall sections the original has where present (opening paragraph, any feature bullets, care instructions, FAQ, etc.), but reword them — don't copy sentences verbatim, and feel free to reorder points within a section.
- If the original has an FAQ heading, render it as "<h2><strong>Frequently Asked Questions</strong></h2>".
- Do not invent new materials, features, or claims not present in the original.

## META DESCRIPTION
Produce a "metaDescription" in ${languageName} of roughly 180-220 characters that starts with "Shop the " followed by the full new title (firstName + titleSuffix) and a period, then a natural second sentence describing the product with its key features/occasions. Keep the same key terms as the original where it had a meta description.

## OUTPUT
Respond with ONLY a valid JSON object, no markdown code fences, no preamble. Schema:
{
  "firstName": string,
  "titleSuffix": string,
  "coreProductTypeEnglish": string, // single core product noun, ALWAYS IN ENGLISH (internal use)
  "gender": string, // "Women" or "Men", in English (internal use)
  "descriptionHtml": string,
  "keyFeature1": string,
  "keyFeature2": string,
  "metaDescription": string
}`;
}

/**
 * Rephrase-mode entry point. Takes the product's EXISTING title +
 * description and rewrites them (same meaning, same keywords, different
 * wording/structure) rather than generating fresh marketing copy. Returns
 * the exact same OptimizedContent shape as generateOptimizedContent, so
 * everything downstream (image metadata stripping + renaming to the new
 * title, new slug/URL, pricing, collections, etc.) works identically.
 */
export async function generateRephrasedContent(
  product: ShopifyProductRaw,
  storeName: string,
  language: LanguageCode
): Promise<OptimizedContent> {
  const strippedDescription = product.body_html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sortedImages = [...product.images].sort((a, b) => a.position - b.position);
  const imageUrls = sortedImages.slice(0, 3).map((img) => img.src);
  const imageBlocksRaw = await Promise.all(imageUrls.map(fetchImageAsBase64Block));
  const imageBlocks = imageBlocksRaw.filter((b): b is ClaudeContentBlock => b !== null);

  const languageName = SUPPORTED_LANGUAGES[language];

  const userContent: ClaudeContentBlock[] = [
    ...imageBlocks,
    {
      type: "text",
      text: [
        `EXISTING product title (rephrase this — keep the same keywords, reword/restructure): ${product.title}`,
        ``,
        `EXISTING product description HTML (rephrase this — keep the same meaning and keywords, reword sentences and you may reorder points, but never copy sentences verbatim):`,
        product.body_html,
        ``,
        `Plain-text version of the same description (for reference): ${strippedDescription}`,
        ``,
        `Store name: ${storeName}`,
        ``,
        `Rephrase the title and description according to the schema and rules above, entirely in ${languageName}. Keep the same keywords; change the wording and structure so it is not a 1:1 copy.`,
      ].join("\n"),
    },
  ];

  const responseText = await callClaude({
    system: buildRephraseSystemPrompt(languageName),
    messages: [{ role: "user", content: userContent }],
    maxTokens: 6000,
  });

  const parsed = parseJsonResponse<ClaudeOutput>(responseText);

  parsed.titleSuffix = enforceTerminology(parsed.titleSuffix, languageName);

  const duplicateWord = findRepeatedSignificantWord(parsed.titleSuffix);
  if (duplicateWord) {
    console.warn(
      `[content-optimizer] (rephrase) WAARSCHUWING: het woord "${duplicateWord}" komt meer dan 1x voor in de titel "${parsed.titleSuffix}".`
    );
  }

  const title = `${parsed.firstName} | ${parsed.titleSuffix}`;
  const slug = slugify(parsed.titleSuffix);

  const descriptionHtml = parsed.descriptionHtml.replace(
    /<h2>\s*(<strong>)?\s*(Frequently Asked Questions|Häufig gestellte Fragen)\s*(<\/strong>)?\s*<\/h2>/i,
    "<h2><strong>$2</strong></h2>"
  );

  return {
    title,
    slug,
    descriptionHtml,
    metaTitle: title,
    coreProductTypeEnglish: parsed.coreProductTypeEnglish,
    metaDescription: truncateMetaDescription(parsed.metaDescription),
    keyFeatures: [parsed.keyFeature1, parsed.keyFeature2],
    gender: parsed.gender,
  };
}
