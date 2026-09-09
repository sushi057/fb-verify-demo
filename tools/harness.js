/**
 * Test harness controller.
 * It calls runVerification() from the extension pipeline. There is no copy of
 * the pipeline here. What you test here is what the extension runs.
 */
import {
  ALLOWED_DOMAINS, INTERNATIONAL_DOMAINS, SOURCE_NAMES
} from "../background/pipeline.js";

/** The harness talks to the bridge it is served from. */
const DEFAULT_BRIDGE = location.origin;

/**
 * Sends one post to the bridge and reports the stages as they arrive.
 * The extension runs the same pipeline in its service worker.
 * @param {object} input {text, images}
 * @param {object} opts {backend}
 * @param {function(object):void} report
 * @returns {Promise<object>} The result.
 * @throws {Error} If the bridge is down or the run fails.
 */
async function runVerification(input, opts, report) {
  const emit = report || function () {};
  let res;
  try {
    res = await fetch(DEFAULT_BRIDGE + "/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: (input.text || "").trim(),
        images: input.images || [],
        backend: (opts && opts.backend) || "deepseek"
      })
    });
  } catch (e) {
    throw new Error("The bridge is not answering. Start it with ./tools/serve.sh");
  }
  if (!res.ok) {
    throw new Error("The bridge returned status " + res.status + ".");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = null;
  let failure = null;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = raw.split("\n").find(function (l) { return l.startsWith("data:"); });
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch (e) {
        continue;
      }
      if (event.type === "result") final = event.result;
      else if (event.type === "error") failure = event.message;
      else emit(event);
    }
  }

  if (failure) throw new Error(failure);
  if (!final) throw new Error("The bridge closed before it sent a result.");
  return final;
}

const STAGES = [
  ["image", "0. Image reading"],
  ["decompose", "a. Claim decomposition"],
  ["salience", "b. Salience assessment"],
  ["retrieve", "c. Evidence retrieval"],
  ["stance", "d. Stance assessment"],
  ["verdict", "e. Verdict logic"],
  ["grounding", "f. Grounding check"]
];

/** Maps the demo post label to the canonical verdict. */
const EXPECTED = {
  "demo-1": "FABRICATED",
  "demo-2": "FABRICATED",
  "demo-3": "INSUFFICIENT_EVIDENCE",
  "demo-4": "VERIFIED"
};

const $ = function (id) { return document.getElementById(id); };
const runs = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* ---------- backend health ---------- */

$("allowlist").textContent =
  "Nepal — " +
  ALLOWED_DOMAINS.map(function (d) { return SOURCE_NAMES[d]; }).join(", ") +
  ".   International — " +
  INTERNATIONAL_DOMAINS
    .map(function (d) { return SOURCE_NAMES[d]; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; })
    .join(", ") + ".";

(async function checkHealth() {
  try {
    const r = await fetch(DEFAULT_BRIDGE + "/health");
    if (!r.ok) throw new Error("bad status");
    const info = await r.json();
    const missing = info.backends && info.backends.deepseek === false;
    $("health").textContent = "The local bridge is up at " + DEFAULT_BRIDGE + "." +
      (missing ? " DEEPSEEK_API_KEY is missing, so use the Claude backend." : "");
    $("health").style.color = missing ? "#b45309" : "#15803d";
    if (missing) $("backend").value = "claude";
  } catch (e) {
    $("health").textContent =
      "The local bridge is not answering at " + DEFAULT_BRIDGE +
      ". Start it with ./tools/serve.sh";
    $("health").style.color = "#b91c1c";
  }
})();

/* ---------- images ---------- */

const images = [];

/**
 * Reads a File into a data URL and shows a thumbnail.
 * @param {File} file
 */
function addImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  if (images.length >= 4) return;
  const reader = new FileReader();
  reader.onload = function () {
    images.push(String(reader.result));
    drawThumbs();
  };
  reader.readAsDataURL(file);
}

function drawThumbs() {
  const box = $("thumbs");
  box.textContent = "";
  images.forEach(function (src, i) {
    const t = el("div", "thumb");
    const img = document.createElement("img");
    img.src = src;
    t.appendChild(img);
    const x = el("button", null, "\u00d7");
    x.title = "Remove this image";
    x.addEventListener("click", function () {
      images.splice(i, 1);
      drawThumbs();
    });
    t.appendChild(x);
    box.appendChild(t);
  });
}

$("pick").addEventListener("click", function () { $("file").click(); });
$("file").addEventListener("change", function (e) {
  Array.from(e.target.files).forEach(addImage);
  e.target.value = "";
});

const drop = $("drop");
["dragenter", "dragover"].forEach(function (ev) {
  drop.addEventListener(ev, function (e) {
    e.preventDefault();
    drop.classList.add("over");
  });
});
["dragleave", "drop"].forEach(function (ev) {
  drop.addEventListener(ev, function (e) {
    e.preventDefault();
    drop.classList.remove("over");
  });
});
drop.addEventListener("drop", function (e) {
  Array.from(e.dataTransfer.files).forEach(addImage);
});

window.addEventListener("paste", function (e) {
  Array.from(e.clipboardData.items).forEach(function (item) {
    if (item.type.startsWith("image/")) addImage(item.getAsFile());
  });
});

/* ---------- demo post chips ---------- */

const demoPosts = (window.VerifyDemo && window.VerifyDemo.DEMO_POSTS) || [];
demoPosts.forEach(function (p, i) {
  const b = el("button", null, (i + 1) + ". " + p.expected.split(" /")[0]);
  b.title = p.text;
  b.addEventListener("click", function () {
    $("text").value = p.text;
    $("url").value = "demo post " + (i + 1) + " (" + p.author + ")";
    $("text").dataset.demoId = p.id;
  });
  $("chips").appendChild(b);
});

/* ---------- one run card ---------- */

/**
 * Makes the card for one run and returns its controller.
 * @param {string} label
 * @param {string} text
 * @param {string|null} demoId
 */
function makeRunCard(label, text, demoId, imgs) {
  const card = el("div", "card");
  const head = el("div", "runhead");
  head.appendChild(el("span", "title", label));
  const status = el("span", "muted", "running…");
  head.appendChild(status);
  card.appendChild(head);

  const excerpt = el("div", "muted");
  excerpt.textContent = text
    ? text.slice(0, 160) + (text.length > 160 ? "\u2026" : "")
    : "(no caption; the claim is in the image)";
  card.appendChild(excerpt);

  if (imgs && imgs.length) {
    const strip = el("div", "runimgs");
    imgs.forEach(function (src) {
      const im = document.createElement("img");
      im.src = src;
      strip.appendChild(im);
    });
    card.appendChild(strip);
  }

  const list = el("ol", "stages");
  const nodes = {};
  STAGES.forEach(function (s) {
    const li = el("li", "s-pending");
    li.appendChild(el("span", "dot"));
    li.appendChild(el("span", null, s[1]));
    li.appendChild(el("span", "snote", ""));
    list.appendChild(li);
    nodes[s[0]] = li;
  });
  card.appendChild(list);

  const qBox = el("div", "block");
  qBox.style.display = "none";
  qBox.appendChild(el("h3", null, "Search queries"));
  const qList = el("ul", "queries");
  qBox.appendChild(qList);
  card.appendChild(qBox);

  const body = el("div");
  card.appendChild(body);

  const results = $("results");
  const first = results.firstElementChild;
  if (first && first.classList.contains("muted")) {
    results.textContent = "";
  }
  results.insertBefore(card, results.firstChild);

  function setStage(key, state, note) {
    const li = nodes[key];
    if (!li) return;
    li.className = "s-" + state;
    if (note !== undefined) li.querySelector(".snote").textContent = note;
  }

  function completeThrough(key) {
    let hit = false;
    STAGES.forEach(function (s) {
      if (hit) return;
      setStage(s[0], "done");
      if (s[0] === key) hit = true;
    });
  }

  return {
    status: status,
    body: body,
    setStage: setStage,
    completeThrough: completeThrough,
    addQuery: function (q) {
      qBox.style.display = "block";
      qList.appendChild(el("li", null, q));
    },
    markFailed: function () {
      STAGES.forEach(function (s) {
        if (nodes[s[0]].className === "s-active") setStage(s[0], "failed");
      });
    },
    demoId: demoId
  };
}

/** Draws the finished result inside a run card. */
function renderResult(card, r) {
  card.completeThrough("grounding");
  card.setStage("salience", "done", r.salience);
  if (r.image_text) card.setStage("image", "done", "text read");
  card.setStage("retrieve", "done", r.searches_run + " searches, " + r.pages_retrieved + " pages");
  card.status.textContent = "";

  const b = card.body;
  b.textContent = "";

  const head = el("div", "block");
  head.appendChild(el("span", "verdict v-" + r.verdict, r.verdict.replace(/_/g, " ")));
  head.appendChild(el("span", "conf", "Confidence " + Math.round(r.confidence * 100) + "%"));

  if (card.demoId && EXPECTED[card.demoId]) {
    const want = EXPECTED[card.demoId];
    const good = want === r.verdict;
    const chip = el("span", "tag " + (good ? "pass" : "fail"),
      good ? "MATCHES EXPECTED" : "EXPECTED " + want.replace(/_/g, " "));
    chip.style.marginLeft = "10px";
    head.appendChild(chip);
  }
  b.appendChild(head);

  if (r.overridden) {
    const o = el("div", "note");
    o.textContent =
      "The verdict rules in pipeline.js overrode the model. Model said " +
      (r.model_verdict || "nothing") + ". The rules said " + r.verdict + ".";
    b.appendChild(o);
  }

  const sal = el("div", "block");
  sal.appendChild(el("h3", null, "Salience"));
  sal.appendChild(el("span", "tag " + (r.salience === "high" ? "sal-high" : "sal-low"),
    r.salience.toUpperCase() + " SALIENCE"));
  sal.appendChild(el("div", null, r.salience_reasoning));
  if (r.expected_sources && r.expected_sources.length) {
    sal.appendChild(el("div", "muted", "Would appear in: " + r.expected_sources.join(", ")));
  }
  if (r.coverage_window_start) {
    const hours = (Date.now() - Date.parse(r.coverage_window_start)) / 3600000;
    sal.appendChild(el("div", "muted",
      "Nepali news feeds covered the last " + hours.toFixed(1) +
      " hours (from " + r.coverage_window_start.slice(0, 16).replace("T", " ") +
      "). Claim date: " + (r.claim_date || "unknown") + "."));
  }
  sal.appendChild(el("div", "muted",
    "Scope: " + (r.claim_scope || "nepal") +
    "  \u00b7  Claim period: " + (r.claim_period || "recent") +
    "  \u00b7  Press carries this claim: " + (r.press_carries_claim ? "yes" : "no") +
    (r.headlines ? "  \u00b7  " + r.headlines + " headline(s) seen" : "")));
  b.appendChild(sal);

  if (r.image_text) {
    const it = el("div", "block");
    it.appendChild(el("h3", null, "Text read from the image"));
    it.appendChild(el("div", "ev-quote", r.image_text));
    b.appendChild(it);
  }

  if (r.claims.length) {
    const c = el("div", "block");
    c.appendChild(el("h3", null, "Atomic claims"));
    const ul = el("ul");
    r.claims.forEach(function (x) { ul.appendChild(el("li", null, x)); });
    c.appendChild(ul);
    b.appendChild(c);
  }

  const why = el("div", "block");
  why.appendChild(el("h3", null, "Why this verdict"));
  why.appendChild(el("div", null, r.verdict_reasoning));
  b.appendChild(why);

  const ev = el("div", "block");
  ev.appendChild(el("h3", null, "Evidence trail (" + r.evidence.length + ")"));
  if (!r.evidence.length) {
    ev.appendChild(el("div", "muted", "No source on the allowlist mentioned this claim."));
  }
  r.evidence.forEach(function (item) {
    const row = el("div", "ev");
    const top = el("div", "ev-top");
    const a = el("a", null, item.source_name);
    a.href = item.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    top.appendChild(a);
    top.appendChild(el("span", "st st-" + item.stance, item.stance));
    row.appendChild(top);
    row.appendChild(el("div", "ev-url", item.url));
    row.appendChild(el("div", "ev-meta", "Retrieved: " + item.retrieved_at));
    if (item.quote) row.appendChild(el("div", "ev-quote", item.quote));
    ev.appendChild(row);
  });
  b.appendChild(ev);

  if (r.dropped_citations.length) {
    const d = el("div", "block");
    d.appendChild(el("h3", null, "Dropped by the grounding check"));
    const ul = el("ul");
    r.dropped_citations.forEach(function (x) { ul.appendChild(el("li", null, x)); });
    d.appendChild(ul);
    b.appendChild(d);
  }

  const det = el("details");
  det.appendChild(el("summary", null,
    "Raw model reply and retrieved URLs (" + r.retrieved_urls.length + ")"));
  det.appendChild(el("pre", null,
    "RETRIEVED URLS\n" + (r.retrieved_urls.join("\n") || "(none)") +
    "\n\nMODEL REPLY\n" + r.raw_text));
  b.appendChild(det);
}

/* ---------- run control ---------- */

/**
 * Runs one verification and draws it.
 * @param {string} label
 * @param {string} text
 * @param {string|null} demoId
 */
async function runOne(label, text, demoId, imgs) {
  const pics = imgs || [];
  const card = makeRunCard(
    label + "  [" + $("backend").value + "]", text, demoId, pics);
  if (!pics.length) card.setStage("image", "done", "no image");

  const started = Date.now();
  try {
    const result = await runVerification(
      { text: text, images: pics },
      { bridge: DEFAULT_BRIDGE, backend: $("backend").value },
      function (ev) {
      if (ev.type === "stage") {
        if (ev.previous) card.completeThrough(ev.previous);
        card.setStage(ev.stage, "active", ev.note);
      } else if (ev.type === "query") {
        card.addQuery(ev.query);
      }
    });
    renderResult(card, result);
    card.status.textContent = ((Date.now() - started) / 1000).toFixed(1) + " s";
    runs.push({
      label: label, backend: $("backend").value, text: text,
      images: pics.length, result: result
    });
  } catch (err) {
    card.markFailed();
    card.status.textContent = "failed";
    const box = el("div", "err");
    box.appendChild(el("h3", null, "Verification failed"));
    box.appendChild(el("div", null, err.message || String(err)));
    box.appendChild(el("div", "muted",
      "No verdict is shown. An error is not evidence."));
    card.body.appendChild(box);
    runs.push({ label: label, text: text, error: err.message || String(err) });
  }
}

$("run").addEventListener("click", async function () {
  const text = $("text").value.trim();
  if (text.length < 15 && images.length === 0) {
    alert("Paste at least 15 characters of post text, or add an image.");
    return;
  }
  const label = $("url").value.trim() || (images.length ? "Pasted image" : "Pasted post");
  const demoId = demoPosts.some(function (p) { return p.text === text; })
    ? demoPosts.find(function (p) { return p.text === text; }).id
    : null;
  $("run").disabled = true;
  await runOne(label, text, demoId, images.slice());
  $("run").disabled = false;
});

$("runall").addEventListener("click", async function () {
  $("runall").disabled = true;
  $("run").disabled = true;
  for (let i = 0; i < demoPosts.length; i += 1) {
    const p = demoPosts[i];
    await runOne("Demo post " + (i + 1) + " \u2014 expect " + p.expected, p.text, p.id, []);
  }
  $("runall").disabled = false;
  $("run").disabled = false;
});

$("clear").addEventListener("click", function () {
  runs.length = 0;
  $("results").textContent = "";
  $("results").appendChild(el("div", "card muted", "Results cleared."));
});

$("export").addEventListener("click", function () {
  const blob = new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "verify-runs-" + new Date().toISOString().slice(0, 19).replace(/:/g, "") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
});
