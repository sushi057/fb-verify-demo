/**
 * Keyless evidence retrieval.
 *
 * No search API and no API key. No browser. Plain HTTP and XML only.
 * The only key this project needs is DEEPSEEK_API_KEY.
 *
 * Three sources, in order of value:
 *
 *   1. Nepal Fact Check full text search. WordPress serves a search result as
 *      an RSS feed at /?s=QUERY&feed=rss2. This gives a real search with real
 *      URLs. A published debunk is the strongest evidence the pipeline can get.
 *
 *   2. Recent article feeds of the news sites. A feed holds the last 5 to 55
 *      articles. The bridge matches the claim words against them. This covers
 *      a fresh claim, which is what a viral post almost always is.
 *
 *   3. Google News search, as RSS, with a site: filter for each allowed domain.
 *      Google News hides the real article URL behind a redirect that needs
 *      JavaScript, so these hits are NOT citable. They are returned as
 *      "headlines", to show whether the Nepali press carries the story at all.
 *
 * A headline can never become a citation. The grounding check in pipeline.js
 * drops any URL that is not a real page from the allowlist.
 */
import { ALLOWED_DOMAINS, ALL_SOURCE_DOMAINS } from "./pipeline.js";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36";

/**
 * International feeds, for a claim about another country.
 * All are open RSS. None needs a key.
 */
const INTERNATIONAL_FEEDS = [
  { domain: "bbc.co.uk", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { domain: "aljazeera.com", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { domain: "theguardian.com", url: "https://www.theguardian.com/world/rss" },
  { domain: "straitstimes.com", url: "https://www.straitstimes.com/news/asia/rss.xml" },
  {
    domain: "channelnewsasia.com",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml"
  },
  { domain: "ndtv.com", url: "https://feeds.feedburner.com/ndtvnews-world-news" }
];

/** Nepali sites that publish a feed of recent articles. */
const RECENT_FEEDS = [
  { domain: "onlinekhabar.com", url: "https://www.onlinekhabar.com/feed" },
  { domain: "setopati.com", url: "https://www.setopati.com/feed" },
  { domain: "techpana.com", url: "https://techpana.com/feed" },
  { domain: "kathmandupost.com", url: "https://kathmandupost.com/rss" },
  { domain: "nepalfactcheck.org", url: "https://nepalfactcheck.org/feed" }
];

/** Sites that answer a full text search. */
const SEARCH_FEEDS = [
  { domain: "nepalfactcheck.org", url: "https://nepalfactcheck.org/?s=QUERY&feed=rss2" }
];

const FEED_TTL_MS = 10 * 60 * 1000;
const feedCache = new Map();

/**
 * Fetches a URL as text.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>} The body, or an empty string on any failure.
 */
async function fetchText(url, timeoutMs) {
  const control = new AbortController();
  const timer = setTimeout(function () { control.abort(); }, timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: control.signal,
      redirect: "follow"
    });
    if (!res.ok) return "";
    return await res.text();
  } catch (e) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the items of an RSS feed.
 *
 * Some feeds hold a character that a strict XML parser rejects. The Kathmandu
 * Post feed is one of them. So this reads the fields with a regular expression
 * and never fails on a broken feed.
 *
 * @param {string} xml
 * @returns {Array<{title: string, link: string, description: string, date: string}>}
 */
export function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

  const field = function (block, name) {
    const m = new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i").exec(block);
    if (!m) return "";
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  blocks.forEach(function (block) {
    const title = field(block, "title");
    let link = field(block, "link");
    if (!link) {
      const m = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
      if (m) link = m[1];
    }
    if (!title) return;
    const src = /<source[^>]*url=["']([^"']+)["']/i.exec(block);
    items.push({
      title: title,
      link: link,
      description: field(block, "description").slice(0, 600),
      date: field(block, "pubDate"),
      sourceUrl: src ? src[1] : ""
    });
  });

  return items;
}

/**
 * Fetches a feed, with a short lived cache.
 * @param {string} url
 * @returns {Promise<Array>} The items.
 */
async function getFeed(url) {
  const hit = feedCache.get(url);
  const now = Date.now();
  if (hit && now - hit.at < FEED_TTL_MS) return hit.items;

  const xml = await fetchText(url, 20000);
  const items = xml ? parseRssItems(xml) : [];
  feedCache.set(url, { at: now, items: items });
  return items;
}

/**
 * Splits a query into words that carry meaning.
 * It keeps Devanagari words and Latin words, and drops the very short ones.
 *
 * A Devanagari vowel sign is a Unicode mark, not a letter. So the split must
 * keep marks inside a word. Without \p{M} a word such as "सार्वजनिक" breaks
 * into pieces and no match is possible.
 * @param {string} query
 * @returns {string[]}
 */
export function queryTokens(query) {
  const stop = new Set([
    "the", "and", "for", "was", "were", "has", "have", "that", "this", "with",
    "from", "nepal", "site", "news", "ma", "ko", "le", "ra", "cha", "chha",
    "छ", "र", "मा", "को", "ले", "को", "हो", "भएको", "गरेको"
  ]);
  return String(query)
    .toLowerCase()
    .replace(/site:[^\s]+/g, " ")
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(function (w) { return w.length >= 3 && !stop.has(w); })
    .slice(0, 12);
}

/**
 * Scores how well an item matches the query words.
 *
 * It compares whole words, not pieces of words. A plain substring test is
 * wrong for Devanagari, because a short word such as "दिन" sits inside many
 * longer words. That made unrelated articles score high.
 *
 * A Nepali word takes suffixes, so a haystack word counts as a match when it
 * starts with the query word and the query word has four letters or more.
 *
 * @param {object} item
 * @param {string[]} tokens
 * @returns {number} The count of matched words.
 */
function scoreItem(item, tokens) {
  const words = new Set(
    (item.title + " " + item.description)
      .toLowerCase()
      .split(/[^\p{L}\p{N}\p{M}]+/u)
      .filter(Boolean)
  );
  const list = Array.from(words);

  let score = 0;
  tokens.forEach(function (t) {
    if (words.has(t)) {
      score += 1;
      return;
    }
    if (t.length >= 4) {
      const inflected = list.some(function (w) {
        return w.length >= t.length && w.startsWith(t);
      });
      if (inflected) score += 1;
    }
  });
  return score;
}

/**
 * Tells if a URL sits on the source allowlist.
 * @param {string} url
 * @returns {boolean}
 */
function onAllowlist(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return false;
  }
  return ALL_SOURCE_DOMAINS.some(function (d) {
    return host === d || host.endsWith("." + d);
  });
}

/**
 * Tells if a URL is a Nepali source. The headline check uses this, because it
 * asks whether the NEPALI press carries a story.
 * @param {string} url
 * @returns {boolean}
 */
function isNepaliSource(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return false;
  }
  return ALLOWED_DOMAINS.some(function (d) {
    return host === d || host.endsWith("." + d);
  });
}

/**
 * Searches Nepal Fact Check.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchFactCheck(query) {
  const out = [];
  for (const feed of SEARCH_FEEDS) {
    const url = feed.url.replace("QUERY", encodeURIComponent(query));
    const items = await getFeed(url);
    items.slice(0, 5).forEach(function (it) {
      if (!onAllowlist(it.link)) return;
      out.push({
        title: it.title,
        url: it.link,
        content: it.description,
        date: it.date,
        via: "fact check search"
      });
    });
  }
  return out;
}

/**
 * Matches the query against the recent articles of every feed.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchRecent(query) {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];

  const all = RECENT_FEEDS.concat(INTERNATIONAL_FEEDS);
  const lists = await Promise.all(all.map(function (f) { return getFeed(f.url); }));
  const scored = [];

  lists.forEach(function (items) {
    items.forEach(function (it) {
      if (!it.link || !onAllowlist(it.link)) return;
      // The item must match a real share of the query, not one common word.
      const need = Math.max(2, Math.ceil(tokens.length * 0.5));
      const score = scoreItem(it, tokens);
      if (score >= need || (tokens.length === 1 && score === 1)) {
        scored.push({
          title: it.title,
          url: it.link,
          content: it.description,
          date: it.date,
          via: "recent articles",
          score: score
        });
      }
    });
  });

  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, 8);
}

/**
 * Asks Google News whether the Nepali press carries the story.
 * The URLs are Google redirects, so these are headlines, not citations.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchHeadlines(query) {
  const sites = ALLOWED_DOMAINS.map(function (d) { return "site:" + d; }).join(" OR ");
  const q = encodeURIComponent(query + " (" + sites + ")");
  const url =
    "https://news.google.com/rss/search?q=" + q + "&hl=ne&gl=NP&ceid=NP:ne";

  const xml = await fetchText(url, 20000);
  const items = xml ? parseRssItems(xml) : [];

  // Google News also returns a page that only mentions an allowed domain.
  // Keep a headline only when its publisher really is on the allowlist.
  return items
    .filter(function (it) { return isNepaliSource(it.sourceUrl); })
    .slice(0, 8)
    .map(function (it) {
      return {
        title: it.title,
        publisher: (it.title.split(" - ").pop() || "").trim(),
        date: it.date,
        note: "Headline only. Google News hides the article URL. Not citable."
      };
    });
}

/**
 * Asks Google News what the world press carries, with no domain filter.
 *
 * This exists for a foreign claim. The allowlist is Nepali, so it cannot say
 * whether something happened in another country. These headlines are outside
 * the allowlist, so they are never evidence and never a citation. They only
 * show whether the story exists in the press at all.
 *
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchWorldHeadlines(query) {
  const url =
    "https://news.google.com/rss/search?q=" + encodeURIComponent(query) +
    "&hl=en&gl=US&ceid=US:en";
  const xml = await fetchText(url, 20000);
  const items = xml ? parseRssItems(xml) : [];

  return items.slice(0, 6).map(function (it) {
    return {
      title: it.title,
      publisher: (it.title.split(" - ").pop() || "").trim(),
      date: it.date,
      note: "Outside the allowlist. Not evidence and not citable."
    };
  });
}

/**
 * Measures how far back the feeds reach.
 *
 * This matters more than it looks. A Nepali news feed holds only the last few
 * hours of articles. So "the press did not report it" really means "it was not
 * published in the last few hours". The verdict rules need to know that, or
 * they call a true story from yesterday a fake.
 *
 * @returns {Promise<{nepal_window_start: string, sources: object[]}>}
 */
export async function coverageWindow() {
  const all = RECENT_FEEDS.concat(INTERNATIONAL_FEEDS);
  const lists = await Promise.all(all.map(function (f) { return getFeed(f.url); }));

  const sources = [];
  let nepalOldest = null;

  all.forEach(function (feed, i) {
    const times = lists[i]
      .map(function (it) { return Date.parse(it.date); })
      .filter(function (t) { return !isNaN(t); });

    const oldest = times.length ? Math.min.apply(null, times) : null;
    const isNepal = RECENT_FEEDS.indexOf(feed) !== -1;

    sources.push({
      domain: feed.domain,
      articles: lists[i].length,
      oldest: oldest ? new Date(oldest).toISOString() : null
    });

    // The fact check site is a search, not a window, so it does not limit it.
    if (isNepal && oldest && feed.domain !== "nepalfactcheck.org") {
      if (nepalOldest === null || oldest > nepalOldest) nepalOldest = oldest;
    }
  });

  return {
    // The window starts where the SHORTEST Nepali feed starts. Before that
    // moment the press cannot be said to be silent.
    nepal_window_start: nepalOldest ? new Date(nepalOldest).toISOString() : null,
    sources: sources
  };
}

/**
 * Runs one search over every keyless source.
 * @param {string} query
 * @returns {Promise<{results: object[], headlines: object[], world: object[]}>}
 */
export async function keylessSearch(query) {
  const [factChecks, recent, headlines, world, coverage] = await Promise.all([
    searchFactCheck(query),
    searchRecent(query),
    searchHeadlines(query),
    searchWorldHeadlines(query),
    coverageWindow()
  ]);

  const seen = new Set();
  const results = [];
  factChecks.concat(recent).forEach(function (r) {
    if (seen.has(r.url)) return;
    seen.add(r.url);
    results.push(r);
  });

  return {
    results: results.slice(0, 8),
    headlines: headlines,
    world: world,
    coverage: coverage
  };
}
