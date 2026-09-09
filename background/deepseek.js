/**
 * DeepSeek backend for the bridge.
 *
 * The DeepSeek API has no web search of its own. It offers function tools only.
 * So the bridge runs the search itself. The search is keyless: it reads the
 * feeds and the search feed of the allowed sites. See search.mjs.
 *
 * Only the allowed sites are ever read, so the source allowlist is enforced at
 * search time. The grounding check in pipeline.js still runs after, so a made
 * up URL is still dropped.
 *
 * The caller passes the API key. Nothing here reads the environment, so the
 * same code runs in the extension service worker and in the test bridge.
 */
import { keylessSearch } from "./search.js";

const DS_URL = "https://api.deepseek.com/chat/completions";
const TEXT_MODEL = "deepseek-v4-flash";
const VISION_MODEL = "deepseek-v4-flash-vision-exp";
const MAX_ROUNDS = 8;
// DeepSeek writes its thinking into reasoning_content, and that shares the
// token budget. Too small a budget leaves nothing for the answer.
const MAX_TOKENS = 8000;
// A hard cap on searches. When it is reached, the model must answer with what
// it has. Without this the model can search for ever and never conclude.
const MAX_SEARCHES = 6;

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the approved Nepali sources for a claim. The search is already " +
      "limited to the source allowlist. It covers the published fact checks in " +
      "full, and the recent articles of the news sites. Search in Nepali and " +
      "in English.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query. Devanagari, Romanized Nepali, or English."
        }
      },
      required: ["query"]
    }
  }
};

/**
 * Calls the DeepSeek chat API.
 * @param {object} body
 * @returns {Promise<object>} The first choice message.
 * @throws {Error} If the API fails.
 */
async function deepseekCall(body, key) {
  if (!key) throw new Error("No DeepSeek API key. Open the extension and add one.");

  const res = await fetch(DS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = await res.text().catch(function () { return ""; });
    throw new Error("DeepSeek returned status " + res.status + ". " + detail.slice(0, 300));
  }
  const data = await res.json();
  if (!data.choices || !data.choices.length) {
    throw new Error("DeepSeek returned no choices.");
  }
  const msg = data.choices[0].message;
  msg.__finish = data.choices[0].finish_reason;
  return msg;
}

/**
 * Runs the pipeline on DeepSeek.
 * @param {string} systemPrompt
 * @param {string} text The post caption.
 * @param {string[]} imageDataUrls The post images, as data URLs.
 * @param {function(object):void} emit Reports a stage to the browser.
 * @param {string} apiKey The DeepSeek API key.
 * @returns {Promise<{finalText: string, retrieved: Map, searchCount: number}>}
 */
export async function runDeepSeek(systemPrompt, text, imageDataUrls, emit, apiKey) {
  const today = new Date().toISOString().slice(0, 10);
  const retrieved = new Map();
  let searchCount = 0;
  let sawSearch = false;
  let toldToStop = false;
  let askedAgain = false;
  const headlineTitles = new Set();
  let windowStart = null;

  const userContent = [];
  userContent.push({
    type: "text",
    text:
      "Today is " + today + ".\n\n<post_caption>\n" +
      (text || "(no caption; the claim is in the image)") +
      "\n</post_caption>"
  });
  imageDataUrls.forEach(function (url) {
    userContent.push({ type: "image_url", image_url: { url: url } });
  });

  if (imageDataUrls.length) emit({ type: "stage", stage: "image", note: "reading image" });

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: imageDataUrls.length ? userContent : userContent[0].text }
  ];

  const model = imageDataUrls.length ? VISION_MODEL : TEXT_MODEL;
  let finalText = "";

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // On the last round, and once the search budget is spent, take the tool
    // away. The model then has to write the result.
    const lastRound = round === MAX_ROUNDS - 1;
    const outOfBudget = searchCount >= MAX_SEARCHES;
    const forceAnswer = lastRound || outOfBudget;

    if (forceAnswer && !toldToStop) {
      toldToStop = true;
      messages.push({
        role: "user",
        content:
          "Stop searching. You have run " + searchCount + " searches. " +
          "Give the verdict now, from the evidence you already have. " +
          "If you found nothing, that is a real finding: apply the salience " +
          "rule in Stage E. Reply with the <result> JSON block."
      });
    }

    const body = {
      model: model,
      messages: messages,
      max_tokens: MAX_TOKENS
    };
    if (!forceAnswer) body.tools = [SEARCH_TOOL];

    const message = await deepseekCall(body, apiKey);

    messages.push(message);

    const calls = message.tool_calls || [];
    if (!calls.length) {
      finalText = message.content || "";

      // The model can spend the whole budget on reasoning and return no
      // content. The result block is often inside the reasoning, so look
      // there before giving up.
      if (!finalText.trim() && /<result>/i.test(message.reasoning_content || "")) {
        finalText = message.reasoning_content;
      }

      if (finalText.trim()) break;

      // Still nothing. Ask once more, briefly, and give the answer room.
      if (!askedAgain) {
        askedAgain = true;
        messages.push({
          role: "user",
          content:
            "Your last reply was empty. Do not think further. Reply now with " +
            "only the <result> JSON block, filled in from the evidence above."
        });
        continue;
      }
      break;
    }

    if (!sawSearch) {
      sawSearch = true;
      emit({ type: "stage", stage: "retrieve", previous: "salience" });
    }

    // Run the searches of one round together. The searches are the slow part.
    const jobs = calls.map(function (call) {
      let query = "";
      try {
        query = (JSON.parse(call.function.arguments || "{}").query) || "";
      } catch (e) {
        query = "";
      }

      searchCount += 1;
      emit({ type: "query", query: query });
      emit({ type: "stage", stage: "retrieve", note: "search " + searchCount });

      return keylessSearch(query).then(
        function (found) {
          return {
            call: call,
            results: found.results,
            headlines: found.headlines,
            world: found.world,
            coverage: found.coverage,
            error: ""
          };
        },
        function (err) {
          return {
            call: call, results: [], headlines: [], world: [],
            coverage: null, error: err.message
          };
        }
      );
    });

    const done = await Promise.all(jobs);

    done.forEach(function (job) {
      (job.headlines || []).forEach(function (h) { headlineTitles.add(h.title); });
      if (job.coverage && job.coverage.nepal_window_start) {
        windowStart = job.coverage.nepal_window_start;
      }
      job.results.forEach(function (r) {
        if (r && r.url) {
          retrieved.set(r.url, { url: r.url, title: r.title || "", retrieved_at: today });
        }
      });

      messages.push({
        role: "tool",
        tool_call_id: job.call.id,
        content: job.error
          ? "The search failed: " + job.error
          : JSON.stringify({
              note:
                "Every result comes from the source allowlist. Cite a URL from " +
                "\"results\" only. An item in \"headlines\" has no URL, so you must " +
                "never cite it; use it only to judge whether the Nepali press " +
                "carries the story at all. An item in \"world_press\" is from " +
                "outside the allowlist: never cite it and never treat it as " +
                "evidence, but for a FOREIGN claim it does show whether the " +
                "story exists in the press at all.",
              results: job.results.map(function (r) {
                return {
                  title: r.title,
                  url: r.url,
                  date: r.date,
                  found_by: r.via,
                  content: String(r.content || "").slice(0, 900)
                };
              }),
              headlines: job.headlines,
              world_press: job.world,
              coverage: job.coverage
            })
      });
    });

    if (retrieved.size) {
      emit({ type: "stage", stage: "retrieve", note: retrieved.size + " pages" });
      emit({ type: "retrieved", count: retrieved.size });
    }
  }

  if (!finalText || !finalText.trim()) {
    throw new Error(
      "DeepSeek returned no answer after " + searchCount + " searches. It spent " +
      "its token budget on reasoning. Run it again, or use the claude backend."
    );
  }

  return {
    finalText: finalText,
    retrieved: retrieved,
    searchCount: searchCount,
    headlines: headlineTitles.size,
    windowStart: windowStart
  };
}
