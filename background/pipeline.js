/**
 * Verification pipeline.
 * One LLM call with web search, then deterministic checks in JavaScript.
 */

/** Sources that the search may use. */
export const ALLOWED_DOMAINS = [
  "techpana.com",
  "nepalfactcheck.org",
  "kathmandupost.com",
  "onlinekhabar.com",
  "setopati.com",
  "ekantipur.com",
  "gov.np"
];

/**
 * International sources, for a claim about another country.
 * The Nepali list cannot judge an event abroad. These are free to read: each
 * one publishes an open RSS feed, so no key is needed.
 */
export const INTERNATIONAL_DOMAINS = [
  "bbc.co.uk",
  "bbc.com",
  "aljazeera.com",
  "theguardian.com",
  "straitstimes.com",
  "channelnewsasia.com",
  "ndtv.com"
];

/** Every domain the grounding check will accept. */
export const ALL_SOURCE_DOMAINS = ALLOWED_DOMAINS.concat(INTERNATIONAL_DOMAINS);

/** Names for the report. */
export const SOURCE_NAMES = {
  "techpana.com": "TechPana Fact Check",
  "nepalfactcheck.org": "Nepal Fact Check",
  "kathmandupost.com": "The Kathmandu Post",
  "onlinekhabar.com": "Onlinekhabar",
  "setopati.com": "Setopati",
  "ekantipur.com": "Ekantipur",
  "gov.np": "Nepal government (.gov.np)",
  "bbc.co.uk": "BBC News",
  "bbc.com": "BBC News",
  "aljazeera.com": "Al Jazeera",
  "theguardian.com": "The Guardian",
  "straitstimes.com": "The Straits Times",
  "channelnewsasia.com": "Channel NewsAsia",
  "ndtv.com": "NDTV"
};

export const SYSTEM_PROMPT = `You check social media posts from Nepal for misinformation.
The post can be in Devanagari Nepali, Romanized Nepali, English, or a mix.
Read all three forms. Do not translate the claim wrongly.

STAGE 0 - IMAGE READING
Many Facebook posts carry the claim in an image, not in the caption.
If the post has an image, read the image first.
Write out the text you see in the image, in the script you see it in.
Include text in a graphic, a poster, a screenshot of a news card, or a
screenshot of another post. If the image and the caption disagree, check both.
Say in "image_text" what you read from the image.

Do these stages in order. Do not skip a stage.

STAGE A - CLAIM DECOMPOSITION
Extract the atomic checkable assertions from the post. An atomic assertion has
one subject, one action, and one object. Ignore opinion and ignore calls to share.

STAGE B - SALIENCE ASSESSMENT
This stage is critical. Salience is NOT about how big the news is. It asks one
question only:

  If this claim were true, would it NECESSARILY appear in the sources this
  search can actually read?

For a claim about Nepal, those sources are: the Nepal Gazette and .gov.np
notices, the published Nepali fact checks, and the recent articles of Kathmandu
Post, Onlinekhabar, Setopati, Ekantipur and TechPana.

For a claim about another country, they are the recent articles of BBC News,
Al Jazeera, The Guardian, The Straits Times, Channel NewsAsia and NDTV.

- "high" means yes, it would necessarily be there. Example: a national public
  holiday, a fuel price change, a cabinet decision, a statement by a Nepali
  minister at a press meeting. Nepali media must cover these.
- "low" means it can be true and still be absent from those sources. This
  includes a private meeting, a private conversation, an internal opinion, AND
  any event that Nepali media may simply not cover.
Write the list of sources where the claim WOULD appear if it were true.

STAGE B2 - CLAIM SCOPE
Set "claim_scope" to "nepal" or "foreign".
- "nepal" means the claim is about Nepal: its government, its people, its
  economy, an event inside Nepal.
- "foreign" means the claim is about another country and does not involve
  Nepal. A cabinet decision in Singapore is "foreign".
This matters more than it looks. The allowlist holds Nepali sources only. A
true foreign story can be missing from every one of them. So absence can never
show that a foreign claim is false.

STAGE C - EVIDENCE RETRIEVAL
Search for the claim. Search in Nepali and in English.
Search for a published fact check of the claim.

Keep every query to three or four words. The search joins the words with AND,
so a long query returns nothing at all. Search for the heart of the claim, not
for the whole sentence. "Myanmar Nepal donation" works; "Myanmar donates
US$500,000 and 8 metric tons of pulses to Nepal flood victims" returns nothing.
If a search returns nothing, shorten it and search again before you conclude
anything.
Only these sources count as evidence.
Nepal: techpana.com, nepalfactcheck.org, kathmandupost.com, onlinekhabar.com,
setopati.com, ekantipur.com, and any .gov.np domain.
International: bbc.com, aljazeera.com, theguardian.com, straitstimes.com,
channelnewsasia.com, ndtv.com.
Run more than one search. Search the claim, and search for a fact check of it.
A result from any other domain is dropped later. Do not rely on it.

STAGE D - STANCE ASSESSMENT
For each source you retrieved, give a stance on the main claim:
"supports", "refutes", or "irrelevant".

STAGE D1 - CLAIM DATE
Give the date of the event in the claim, as "claim_date", in YYYY-MM-DD form.
Use the date the post says. If the post says "tomorrow" or "from tomorrow",
use tomorrow's date. If no date can be worked out, write "unknown".

The tool result carries a "coverage" block. It says how far back the Nepali
news feeds reach. That is often only a few hours. If your claim date is before
that moment, the feeds simply cannot show whether the press reported it.

STAGE D2 - CLAIM PERIOD
Say when the claim happened. Use "recent" if the event is inside the last 30
days, or if the post says it is about to happen. Use "older" for anything else.
This matters: the search reads the recent articles of the news sites and the
published fact checks. It cannot read an old archive. So silence about an older
event proves nothing.

STAGE E - VERDICT
Apply this logic. Do not shortcut it.
1. Refuting evidence found (for example a published debunk):
   verdict FABRICATED, confidence 0.85 or more.
2. Supporting evidence from a credible source: verdict VERIFIED.
3. No evidence found AND salience is "high": verdict FABRICATED,
   confidence 0.8 or more. State the reason in this form:
   "A claim of this significance would appear in [expected sources];
   it is absent from all of them."
4. No evidence found AND salience is "low": verdict INSUFFICIENT_EVIDENCE.
   Never call a low salience absence fake.
5. No evidence found AND the claim period is "older": verdict
   INSUFFICIENT_EVIDENCE, whatever the salience. The search cannot see the
   archive, so absence is not a finding.
5a. No evidence found AND the claim date is before the start of the feed
   coverage window, OR the claim carries no date at all: verdict
   INSUFFICIENT_EVIDENCE. The feeds hold only the last few hours. If the claim
   is older than that, or if its date cannot be read, the feeds cannot show
   silence about it. A published fact check still counts, because that search
   reads the whole archive.
   Give "claim_date" whenever the post states or implies one, including "today"
   and "tomorrow". Write "unknown" only when the post really gives no date.
5b. No evidence found AND the claim scope is "foreign": verdict
   INSUFFICIENT_EVIDENCE, whatever the salience. The international list is short
   and it holds recent articles only, so it cannot show that a foreign claim is
   false. Supporting evidence from it IS enough to answer VERIFIED.
5c. The searches returned nothing at all, anywhere, not even in the world
   press: verdict INSUFFICIENT_EVIDENCE. That is a failed search, not an
   absent claim. Say so plainly.
5d. No evidence found, but the world press carries this same event: verdict
   INSUFFICIENT_EVIDENCE. A story reported abroad is not absent from the
   record. The allowlist simply cannot cite it. Set "world_press_carries_claim"
   to true when an item in "world_press" is about this same event, even though
   its source is outside the allowlist.
6. A headline names THIS claim: the press does carry the story, so the claim is
   NOT absent. Never answer FABRICATED on absence in that case. Set
   "press_carries_claim" to true only when a headline is about this same event.
   A headline on the same subject is not enough. "Public holiday for the
   election" is NOT the claim "a 7 day holiday starts tomorrow".
Never reason "nothing found, therefore fake" without the salience check.

STAGE F - GROUNDING
Cite only a URL that your search actually returned. Do not invent a URL.
Do not state a stance that the page does not carry.

OUTPUT
Write every JSON field in English, so that the panel reads the same for every
post. The one exception is "image_text". Keep that in the script of the image.
Write your reasoning first. Then end your reply with one JSON object inside
<result></result> tags, in this shape:
<result>
{
  "image_text": "...",
  "claims": ["..."],
  "salience": "high" | "low",
  "claim_period": "recent" | "older",
  "claim_date": "YYYY-MM-DD" | "unknown",
  "claim_scope": "nepal" | "foreign",
  "press_carries_claim": true | false,
  "world_press_carries_claim": true | false,
  "salience_reasoning": "...",
  "expected_sources": ["..."],
  "evidence": [
    {"source_name": "...", "url": "https://...", "stance": "supports|refutes|irrelevant", "quote": "..."}
  ],
  "verdict": "VERIFIED" | "FABRICATED" | "INSUFFICIENT_EVIDENCE",
  "confidence": 0.0,
  "verdict_reasoning": "..."
}
</result>`;

/**
 * Reads the domain of a URL.
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

/**
 * Tells if a URL is on the allowlist.
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowed(url) {
  const host = hostOf(url);
  if (!host) return false;
  return ALL_SOURCE_DOMAINS.some(function (d) {
    return host === d || host.endsWith("." + d);
  });
}

/**
 * Gives the display name of a source.
 * @param {string} url
 * @param {string} fallback
 * @returns {string}
 */
export function sourceNameFor(url, fallback) {
  const host = hostOf(url);
  for (const d of ALL_SOURCE_DOMAINS) {
    if (host === d || host.endsWith("." + d)) return SOURCE_NAMES[d];
  }
  return fallback || host;
}

/**
 * Pulls the JSON object out of the model reply.
 * @param {string} text
 * @returns {object}
 * @throws {Error} If no valid JSON is found.
 */
export function parseResult(text) {
  let raw = null;
  const tagged = text.match(/<result>([\s\S]*?)<\/result>/i);
  if (tagged) {
    raw = tagged[1];
  } else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) raw = text.slice(start, end + 1);
  }
  if (!raw) throw new Error("The model reply had no JSON result block.");

  raw = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  return JSON.parse(raw);
}

/**
 * Stage F, in code. Drops a citation that the search did not return,
 * or that is not on the allowlist.
 * @param {object[]} evidence Evidence from the model.
 * @param {Map<string,object>} retrieved URLs that the search really returned.
 * @returns {{kept: object[], dropped: string[]}}
 */
export function groundingCheck(evidence, retrieved) {
  const kept = [];
  const dropped = [];
  const retrievedHosts = new Set();
  retrieved.forEach(function (v, url) { retrievedHosts.add(hostOf(url)); });

  (evidence || []).forEach(function (item) {
    if (!item || !item.url) {
      dropped.push("A citation had no URL.");
      return;
    }
    if (!isAllowed(item.url)) {
      dropped.push(item.url + " — not on the source allowlist.");
      return;
    }
    const hit = retrieved.get(item.url) || retrieved.get(item.url.replace(/\/$/, ""));
    if (!hit && !retrievedHosts.has(hostOf(item.url))) {
      dropped.push(item.url + " — the search never returned this page.");
      return;
    }
    kept.push({
      source_name: sourceNameFor(item.url, item.source_name),
      url: item.url,
      stance: ["supports", "refutes", "irrelevant"].includes(item.stance)
        ? item.stance
        : "irrelevant",
      quote: (item.quote || "").slice(0, 300),
      retrieved_at: (hit && hit.retrieved_at) || new Date().toISOString().slice(0, 10)
    });
  });

  return { kept: kept, dropped: dropped };
}

/**
 * Stage E, in code. The verdict must follow the evidence and the salience.
 * This overrides the model if the model shortcut the logic.
 * @param {object} parsed The model result.
 * @param {object[]} evidence The grounded evidence.
 * @param {object} [context] {headlines: number} The count of press headlines
 *   that name the claim. A headline has no citable URL, so it is not evidence,
 *   but it does prove the press carries the story.
 * @returns {{verdict: string, confidence: number, verdict_reasoning: string, overridden: boolean}}
 */
export function applyVerdictLogic(parsed, evidence, context) {
  const salience = parsed.salience === "high" ? "high" : "low";
  const older = parsed.claim_period === "older";

  // The news feeds hold only the last few hours. If the event is older than
  // the window, their silence is meaningless. This is measured, not guessed:
  // the window start comes from the oldest article in the shortest feed.
  const windowStart = (context && context.windowStart) || null;
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed.claim_date || "");
  let beforeWindow = false;
  if (windowStart && hasDate) {
    // Compare whole days. A feed that starts at 11:00 today still says
    // something about the whole of today.
    beforeWindow = parsed.claim_date < String(windowStart).slice(0, 10);
  }
  // An undated claim cannot be placed against a window of a few hours, so
  // silence in the feeds cannot convict it either.
  const undated = Boolean(windowStart) && !hasDate;
  // The allowlist holds Nepali sources only. Silence in them says nothing
  // about an event in another country.
  const foreign = parsed.claim_scope === "foreign";
  // Whether the press carries this same claim is a judgement about meaning, so
  // the model makes it. A count of headlines cannot: a search for a fake
  // 7 day holiday returns every headline about any holiday.
  const pressCarries = parsed.press_carries_claim === true;
  // A story the world press reports is not missing from the record, even when
  // no allowed source can be cited for it.
  const worldCarries = parsed.world_press_carries_claim === true;
  const headlines = (context && Number(context.headlines)) || 0;

  // A search that returned nothing anywhere has told us nothing. Treating it
  // as absence is how a true claim gets called fake, so it cannot.
  const searched = context && context.searched !== undefined
    ? Number(context.searched)
    : null;
  const searchFailed = searched === 0;
  const refutes = evidence.filter(function (e) { return e.stance === "refutes"; });
  const supports = evidence.filter(function (e) { return e.stance === "supports"; });

  let verdict;
  let confidence;
  let reasoning = parsed.verdict_reasoning || "";

  if (refutes.length > 0) {
    verdict = "FABRICATED";
    confidence = Math.max(Number(parsed.confidence) || 0, 0.85);
  } else if (supports.length > 0) {
    verdict = "VERIFIED";
    confidence = Math.max(Number(parsed.confidence) || 0, 0.7);
  } else if (searchFailed) {
    verdict = "INSUFFICIENT_EVIDENCE";
    confidence = 0.3;
    reasoning =
      "The searches came back empty everywhere, including the world press. " +
      "That points at the search, not at the claim. Nothing here shows the " +
      "claim is false. " + reasoning;
  } else if (pressCarries || worldCarries) {
    // The press does carry this story. It is not absent, so it cannot be
    // called fabricated on absence. There is no citable URL, so it is not
    // verified either.
    verdict = "INSUFFICIENT_EVIDENCE";
    confidence = 0.45;
    reasoning = (pressCarries
      ? "The allowed sources do carry this story" +
        (headlines ? " (" + headlines + " headline(s) matched)" : "") + ", "
      : "The press outside the allowlist carries this story, ") +
      "but the search could not reach a citable page for it. The claim is " +
      "not absent from the press, so it must not be called fabricated. " + reasoning;
  } else if (beforeWindow || undated) {
    verdict = "INSUFFICIENT_EVIDENCE";
    confidence = 0.4;
    reasoning = (beforeWindow
      ? "The event is dated " + parsed.claim_date + ", but the news feeds only " +
        "reach back to " + String(windowStart).slice(0, 16).replace("T", " ") + ". "
      : "The post carries no date, and the news feeds reach back only a few " +
        "hours. ") +
      "The feeds cannot show that the press stayed silent about a day they do " +
      "not cover, so absence proves nothing here. " + reasoning;
  } else if (foreign) {
    verdict = "INSUFFICIENT_EVIDENCE";
    confidence = 0.4;
    reasoning =
      "The claim is about another country. Every source on the allowlist is " +
      "Nepali, so these sources are not an authority on it. A true foreign " +
      "story can be absent from all of them, and absence here is not a " +
      "finding. " + reasoning;
  } else if (older) {
    // The search reads recent articles and published fact checks only.
    // It cannot read an archive, so silence about an old event means nothing.
    verdict = "INSUFFICIENT_EVIDENCE";
    confidence = 0.4;
    reasoning =
      "The claim is about an older event. This search reads the recent " +
      "articles of the allowed sites and the published fact checks. It cannot " +
      "read the archive, so finding nothing is not a finding. " + reasoning;
  } else if (salience === "high") {
    verdict = "FABRICATED";
    confidence = Math.max(Number(parsed.confidence) || 0, 0.8);
    // Do not repeat the sentence if the model already wrote it.
    if (!/absent from all of them/i.test(reasoning)) {
      const expected = (parsed.expected_sources || []).join(", ") ||
        "the Nepal Gazette, the ministry notices, and the major Nepali outlets";
      reasoning =
        "A claim of this significance would appear in " + expected +
        "; it is absent from all of them. " + reasoning;
    }
  } else {
    verdict = "INSUFFICIENT_EVIDENCE";
    confidence = Math.min(Number(parsed.confidence) || 0.4, 0.5);
    reasoning =
      "No source on the allowlist reports this claim. The claim is low salience, " +
      "so a true claim of this kind can leave no public record. Absence of a " +
      "record is not proof that the claim is false. " + reasoning;
  }

  const overridden = parsed.verdict !== verdict;
  if (overridden) {
    reasoning +=
      " (The verdict rules in the extension changed the model verdict from " +
      (parsed.verdict || "none") + " to " + verdict + ".)";
  }

  return {
    verdict: verdict,
    confidence: Math.min(Math.max(confidence, 0), 1),
    verdict_reasoning: reasoning.trim(),
    overridden: overridden
  };
}


/**
 * Turns the model reply into the final result. Shared by both backends.
 * @param {string} finalText
 * @param {Map} retrieved
 * @param {number} searchCount
 * @param {string} backend
 * @param {function(object):void} emit
 * @returns {object}
 * @throws {Error} If the reply carries no usable JSON.
 */
export function finishRun(finalText, retrieved, searchCount, backend, emit, headlines, windowStart, imagesRead, searched) {
  if (!searchCount) {
    emit({ type: "stage", stage: "retrieve", previous: "salience", note: "no search run" });
  }
  emit({ type: "stage", stage: "verdict", previous: "stance" });

  const parsed = parseResult(finalText);

  emit({ type: "stage", stage: "grounding", previous: "verdict" });
  const grounded = groundingCheck(parsed.evidence, retrieved);
  const decided = applyVerdictLogic(parsed, grounded.kept, {
    headlines: headlines || 0,
    windowStart: windowStart || null,
    searched: searched === undefined ? null : searched
  });

  return {
    backend: backend,
    images_read: imagesRead || 0,
    image_text: parsed.image_text || "",
    claims: Array.isArray(parsed.claims) ? parsed.claims : [],
    claim_period: parsed.claim_period === "older" ? "older" : "recent",
    claim_date: parsed.claim_date || "unknown",
    coverage_window_start: windowStart || null,
    press_carries_claim: parsed.press_carries_claim === true,
    world_press_carries_claim: parsed.world_press_carries_claim === true,
    claim_scope: parsed.claim_scope === "foreign" ? "foreign" : "nepal",
    headlines: headlines || 0,
    salience: parsed.salience === "high" ? "high" : "low",
    salience_reasoning: parsed.salience_reasoning || "",
    expected_sources: parsed.expected_sources || [],
    evidence: grounded.kept,
    dropped_citations: grounded.dropped,
    verdict: decided.verdict,
    confidence: decided.confidence,
    verdict_reasoning: decided.verdict_reasoning,
    model_verdict: parsed.verdict || null,
    overridden: decided.overridden,
    searches_run: searchCount,
    search_hits: searched === undefined ? null : searched,
    pages_retrieved: retrieved.size,
    retrieved_urls: Array.from(retrieved.keys()),
    raw_text: finalText
  };
}

