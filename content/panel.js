/**
 * The verdict panel.
 *
 * The panel opens as a small card anchored to the Verify button, the way a
 * menu opens in Facebook. It floats, so the feed does not move under the
 * reader. Escape, a click outside, or the close button all shut it.
 *
 * Inside, it is laid out as an inspection record. The stage column uses the
 * same letters as the pipeline stages, so what the class sees on screen maps
 * to the stages in the README. The coverage scale shows what the check could
 * actually read, which is the point the whole demo is built around.
 */
(function () {
  "use strict";

  const STAGES = [
    { key: "image", mark: "0", label: "Read the image" },
    { key: "decompose", mark: "a", label: "Break out the claims" },
    { key: "salience", mark: "b", label: "Weigh the salience" },
    { key: "retrieve", mark: "c", label: "Search the sources" },
    { key: "stance", mark: "d", label: "Judge each source" },
    { key: "verdict", mark: "e", label: "Apply the rules" },
    { key: "grounding", mark: "f", label: "Check every citation" }
  ];

  const VERDICT_LABEL = {
    VERIFIED: "Verified",
    FABRICATED: "Fabricated",
    INSUFFICIENT_EVIDENCE: "Not established"
  };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /**
   * Cuts a string at a word break.
   * @param {string} text
   * @param {number} max
   * @returns {string}
   */
  function trim(text, max) {
    const t = String(text || "").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return (space > max * 0.6 ? cut.slice(0, space) : cut) + "\u2026";
  }

  /**
   * Keeps the first sentences of a paragraph.
   * @param {string} text
   * @param {number} count
   * @returns {string}
   */
  function firstSentences(text, count) {
    const parts = String(text || "").match(/[^.!?]+[.!?]+/g);
    if (!parts) return String(text || "");
    return parts.slice(0, count).join(" ").trim();
  }

  function clockNow() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0");
  }

  /**
   * Draws the coverage scale.
   *
   * The band is the stretch of time the news feeds cover. The mark is the day
   * of the claim. When the mark sits left of the band, the feeds never saw
   * that day, so their silence says nothing.
   *
   * @param {object} r The result.
   * @returns {Element|null}
   */
  /**
   * Says in one line what the check could read, and how the claim sits
   * against it. The drawn scale lives in the details.
   * @param {object} r
   * @returns {string}
   */
  function coverageLine(r) {
    if (!r.coverage_window_start) return "";
    const hours = (Date.now() - Date.parse(r.coverage_window_start)) / 3600000;
    const read = "Read " + hours.toFixed(0) + " h of Nepali news.";

    // The window only matters when the verdict turned on it. Once a source
    // has settled the claim, saying what the feeds could not see is noise.
    if (r.evidence && r.evidence.some(function (e) {
      return e.stance === "supports" || e.stance === "refutes";
    })) {
      return read;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.claim_date || "")) {
      return read + " The post carries no date, so that silence proves nothing.";
    }
    const claim = Date.parse(r.claim_date + "T12:00:00Z");
    if (claim < Date.parse(r.coverage_window_start)) {
      return read + " The post is older than that, so silence proves nothing.";
    }
    return read + " The post falls inside that window.";
  }

  function renderCoverage(r) {
    if (!r.coverage_window_start) return null;

    const start = Date.parse(r.coverage_window_start);
    if (isNaN(start)) return null;

    const now = Date.now();
    const hours = (now - start) / 3600000;
    const claim = /^\d{4}-\d{2}-\d{2}$/.test(r.claim_date || "")
      ? Date.parse(r.claim_date + "T12:00:00Z")
      : null;

    // The scale must hold the window, today, and the claim, wherever it falls.
    // A claim dated tomorrow sits to the right of now, so the range grows both
    // ways. One day of padding keeps a mark off the very edge.
    const day = 86400000;
    let lo = Math.min(start, claim === null ? start : claim) - day;
    let hi = Math.max(now, claim === null ? now : claim) + day * 0.5;
    if (hi - lo < 2 * day) lo = hi - 2 * day;
    const span = hi - lo;
    const pct = function (t) { return ((t - lo) / span) * 100; };

    const box = el("div", "vf-coverage");
    const head = el("div", "vf-coverage-head");
    head.appendChild(el("span", null, "What the check could read"));
    head.appendChild(el("span", null, hours.toFixed(1) + " h of news"));
    box.appendChild(head);

    const scale = el("div", "vf-scale");

    const bandLeft = pct(start);
    const bandRight = pct(now);
    const band = el("div", "vf-scale-band");
    band.style.left = bandLeft + "%";
    // A four hour window is a hairline on a three day scale. Keep it visible.
    band.style.width = Math.max(bandRight - bandLeft, 1.5) + "%";
    band.title = "The Nepali news feeds reach back to " +
      r.coverage_window_start.slice(0, 16).replace("T", " ");
    scale.appendChild(band);

    const bandTag = el("span", "vf-scale-tag", "feed window");
    bandTag.style.left = Math.min(bandLeft, 86) + "%";
    scale.appendChild(bandTag);

    if (claim !== null) {
      const at = pct(claim);
      const mark = el("div", "vf-scale-mark");
      mark.style.left = Math.max(0, Math.min(100, at)) + "%";
      const label = el("span", "vf-scale-mark-label", r.claim_date);
      // Keep the label inside the box at both ends.
      if (at > 78) label.style.transform = "translateX(-100%)";
      else if (at < 12) label.style.transform = "translateX(0)";
      mark.appendChild(label);
      scale.appendChild(mark);
    }
    box.appendChild(scale);

    const ends = el("div", "vf-scale-ends");
    ends.appendChild(el("span", null, new Date(lo).toISOString().slice(0, 10)));
    ends.appendChild(el("span", null, "now \u2192"));
    box.appendChild(ends);

    let note;
    if (claim === null) {
      note = "No date could be read from the post.";
    } else if (claim < start) {
      note = "The post is dated before the feeds begin. They cannot show " +
        "whether the press reported it, so silence is not a finding.";
    } else if (claim > now) {
      note = "The post is about a day still to come. An announcement of this " +
        "kind would already be in today's news, so the feeds can speak to it.";
    } else {
      note = "The post falls inside the window, so the feeds can speak to it.";
    }
    box.appendChild(el("div", "vf-coverage-note", note));

    return box;
  }

  /**
   * Puts the card next to its button, and keeps it there while the feed
   * scrolls. It opens below the button, or above when there is no room.
   * @param {Element} panel
   * @param {Element} anchor
   */
  function place(panel, anchor) {
    const gap = 8;
    const margin = 10;
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;

    let left = a.left;
    // Keep the whole card on screen.
    left = Math.min(left, window.innerWidth - w - margin);
    left = Math.max(margin, left);

    const roomBelow = window.innerHeight - a.bottom - gap - margin;
    let top;
    if (roomBelow >= h || roomBelow >= a.top - gap - margin) {
      top = a.bottom + gap;
    } else {
      top = a.top - gap - h;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));

    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }

  /**
   * Builds the card and anchors it to the button.
   * @param {Element} anchor The Verify button.
   * @returns {object} The panel controller.
   */
  function createPanel(anchor) {
    // Only one card at a time, the way one menu is open at a time.
    Array.from(document.querySelectorAll(".vf-panel")).forEach(function (p) {
      if (p.__vfClose) p.__vfClose();
      else p.remove();
    });

    const panel = el("div", "vf-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Verification record");

    const head = el("div", "vf-head");
    head.appendChild(el("span", "vf-head-title", "Verification record"));
    const meta = el("span", "vf-head-meta", clockNow());
    head.appendChild(meta);
    const close = el("button", "vf-close", "\u00d7");
    close.setAttribute("aria-label", "Close this record");
    head.appendChild(close);
    panel.appendChild(head);

    const scroll = el("div", "vf-scroll");
    panel.appendChild(scroll);

    const list = el("ol", "vf-stages");
    const nodes = {};
    STAGES.forEach(function (s) {
      const li = el("li", "vf-stage vf-stage-pending");
      li.appendChild(el("span", "vf-stage-key", s.mark));
      li.appendChild(el("span", null, s.label));
      li.appendChild(el("span", "vf-stage-note", ""));
      list.appendChild(li);
      nodes[s.key] = li;
    });
    scroll.appendChild(list);

    const body = el("div", "vf-body");
    scroll.appendChild(body);
    document.body.appendChild(panel);

    /** Shuts the card and drops every listener it added. */
    function shut() {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
      if (anchor) anchor.setAttribute("aria-expanded", "false");
      panel.remove();
    }
    panel.__vfClose = shut;

    let frame = 0;
    function reposition() {
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        if (!document.body.contains(anchor)) {
          shut();
          return;
        }
        place(panel, anchor);
      });
    }

    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        shut();
      }
    }

    function onOutside(ev) {
      if (panel.contains(ev.target) || anchor.contains(ev.target)) return;
      shut();
    }

    close.addEventListener("click", shut);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);

    if (anchor) anchor.setAttribute("aria-expanded", "true");
    place(panel, anchor);

    function setStage(key, state, note) {
      const li = nodes[key];
      if (!li) return;
      // A stage that is already done must not go back to active.
      const wasDone = li.classList.contains("vf-stage-done");
      if (!(wasDone && state === "active")) {
        li.className = "vf-stage vf-stage-" + state;
      }
      if (note !== undefined) li.querySelector(".vf-stage-note").textContent = note;
    }

    function completeThrough(key) {
      let hit = false;
      STAGES.forEach(function (s) {
        if (hit) return;
        setStage(s.key, "done");
        if (s.key === key) hit = true;
      });
    }

    function block(title) {
      const b = el("div", "vf-block");
      b.appendChild(el("div", "vf-block-title", title));
      return b;
    }

    /**
     * Draws the finished record.
     * @param {object} r
     */
    function showResult(r) {
      completeThrough("grounding");
      setStage("salience", "done", r.salience === "high" ? "high" : "low");
      setStage("retrieve", "done", r.pages_retrieved + " pages");
      setStage("image", "done", r.images_read ? "text read" : "no image");
      body.textContent = "";

      const row = el("div", "vf-verdict-row");
      row.appendChild(el(
        "span",
        "vf-verdict vf-v-" + r.verdict,
        VERDICT_LABEL[r.verdict] || r.verdict
      ));

      const conf = el("div", "vf-conf");
      conf.appendChild(el("span", "vf-conf-label", "Confidence"));
      const track = el("div", "vf-conf-track");
      const fill = el("div", "vf-conf-fill");
      fill.style.width = Math.round(r.confidence * 100) + "%";
      track.appendChild(fill);
      conf.appendChild(track);
      conf.appendChild(el("span", "vf-conf-num", Math.round(r.confidence * 100) + "%"));
      row.appendChild(conf);
      body.appendChild(row);

      // The stages mattered while it ran. Now the verdict does, so the list
      // moves into the details and the header keeps the summary.
      meta.textContent = r.searches_run + " searches \u00b7 " +
        r.pages_retrieved + " pages";
      list.remove();

      const chips = el("div", "vf-chips");
      chips.style.marginTop = "13px";
      chips.appendChild(el(
        "span",
        "vf-chip " + (r.salience === "high" ? "vf-chip-high" : "vf-chip-low"),
        (r.salience === "high" ? "high" : "low") + " salience"
      ));
      chips.appendChild(el("span", "vf-chip", (r.claim_scope || "nepal") + " claim"));
      if (r.claim_date && r.claim_date !== "unknown") {
        chips.appendChild(el("span", "vf-chip", "dated " + r.claim_date));
      }
      body.appendChild(chips);

      const line = coverageLine(r);
      if (line) body.appendChild(el("div", "vf-coverage-line", line));

      // The reason comes first and short. The rest is there if it is wanted.
      const why = block("Why");
      const full = r.verdict_reasoning || "";
      const brief = firstSentences(full, 2);
      why.appendChild(el("div", "vf-text", brief));
      if (brief && full.length > brief.length + 20) {
        const rest = el("div", "vf-text vf-more-why", full.slice(brief.length).trim());
        why.appendChild(rest);
        const moreWhy = el("button", "vf-link", "Read the full reasoning");
        moreWhy.addEventListener("click", function () {
          why.classList.add("vf-show-all");
          moreWhy.remove();
        });
        why.appendChild(moreWhy);
      }
      body.appendChild(why);

      const items = r.evidence || [];
      const ev = block("Evidence (" + items.length + ")");
      if (!items.length) {
        ev.appendChild(el("div", "vf-empty",
          "No page in the source list mentions this claim."));
      }

      // Show the sources that carry weight. A refuting or supporting page
      // decides the verdict; an irrelevant one only pads the list.
      const ranked = items.slice().sort(function (a, b) {
        const w = { refutes: 0, supports: 1, irrelevant: 2 };
        return (w[a.stance] || 2) - (w[b.stance] || 2);
      });
      const FIRST = 2;

      ranked.forEach(function (item, i) {
        const rowEv = el("div", "vf-ev vf-ev-" + item.stance);
        if (i >= FIRST) rowEv.classList.add("vf-more-ev");
        const top = el("div", "vf-ev-top");
        const a = el("a", "vf-ev-src", item.source_name);
        a.href = item.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = item.url;
        top.appendChild(a);
        top.appendChild(el("span", "vf-stance vf-st-" + item.stance, item.stance));
        rowEv.appendChild(top);
        if (item.quote) {
          rowEv.appendChild(el("div", "vf-ev-quote", trim(item.quote, 150)));
        }
        ev.appendChild(rowEv);
      });

      if (ranked.length > FIRST) {
        const more = el("button", "vf-link",
          "Show " + (ranked.length - FIRST) + " more");
        more.addEventListener("click", function () {
          ev.classList.add("vf-show-all");
          more.remove();
        });
        ev.appendChild(more);
      }
      body.appendChild(ev);

      // Everything below is detail. It stays folded until it is asked for.
      const det = document.createElement("details");
      det.className = "vf-details";
      const sum = document.createElement("summary");
      sum.textContent = "How this was checked";
      det.appendChild(sum);

      const cover = renderCoverage(r);
      if (cover) det.appendChild(cover);

      const stagesBlock = block("Stages");
      list.classList.add("vf-stages-done");
      stagesBlock.appendChild(list);
      det.appendChild(stagesBlock);

      const sal = block("Salience");
      sal.appendChild(el("div", "vf-text", r.salience_reasoning || ""));
      if (r.claim_scope === "foreign") {
        sal.appendChild(el("div", "vf-empty",
          "The claim is about another country, so the Nepali sources cannot " +
          "settle it."));
      }
      det.appendChild(sal);

      if (r.images_read && r.image_text) {
        const it = block("Text read from the image");
        it.appendChild(el("div", "vf-ev-quote", trim(r.image_text, 300)));
        det.appendChild(it);
      }

      if (r.claims && r.claims.length) {
        const c = block("Claims checked");
        const ul = el("ul", "vf-list");
        r.claims.forEach(function (x) { ul.appendChild(el("li", null, x)); });
        c.appendChild(ul);
        det.appendChild(c);
      }

      if (r.dropped_citations && r.dropped_citations.length) {
        const d = block("Citations dropped");
        const ul = el("ul", "vf-list");
        r.dropped_citations.forEach(function (x) { ul.appendChild(el("li", null, x)); });
        d.appendChild(ul);
        d.classList.add("vf-dropped");
        det.appendChild(d);
      }

      body.appendChild(det);

      body.appendChild(el("div", "vf-foot",
        "A model wrote this. Read the sources before you repeat it."));
    }

    /**
     * Draws an error. It never shows a verdict.
     * @param {string} message
     */
    function showError(message) {
      STAGES.forEach(function (s) {
        if (nodes[s.key].classList.contains("vf-stage-active")) {
          setStage(s.key, "failed");
        }
      });
      body.textContent = "";
      const box = el("div", "vf-error");
      box.appendChild(el("div", "vf-error-title", "The check did not finish"));
      box.appendChild(el("div", "vf-text", message));
      box.appendChild(el("div", "vf-foot",
        "No verdict is shown. A failed check is not a finding."));
      body.appendChild(box);
    }

    return {
      node: panel,
      close: shut,
      setStage: setStage,
      completeThrough: completeThrough,
      showResult: function (r) {
        showResult(r);
        place(panel, anchor);
      },
      showError: function (m) {
        showError(m);
        place(panel, anchor);
      }
    };
  }

  window.VerifyPanel = { createPanel: createPanel, STAGES: STAGES };
})();
