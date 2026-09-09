/**
 * Content script entry point.
 *
 * It finds the posts in the feed and puts a Verify button on each one.
 *
 * Facebook rewrites its markup often, so nothing here trusts one shape. Every
 * step checks its own work: if the button lands somewhere invisible, the code
 * moves it to a corner of the post instead. Run window.verifyReport() in the
 * console to see what was found and where each button went.
 */
(function () {
  "use strict";

  const PROCESSED = window.FBSelect.PROCESSED_ATTR;

  /** What the last scans found. window.verifyReport() prints it. */
  const report = { scans: 0, placed: 0, posts: [] };

  /**
   * Prints what the extension found. Use it when no button appears.
   * @returns {object} The report.
   */
  window.verifyReport = function () {
    const feed = window.FBSelect.findFeed();
    const info = {
      feedFound: Boolean(feed),
      articlesOnPage: document.querySelectorAll('[role="article"]').length,
      postsAccepted: window.FBSelect.findPosts().length,
      buttonsPlaced: report.placed,
      buttonsInDom: document.querySelectorAll(".vf-btn").length,
      scans: report.scans
    };
    console.table(info);
    if (report.posts.length) console.table(report.posts);
    return info;
  };

  /**
   * Runs the pipeline for one post and drives the panel.
   * @param {Element} post
   */
  function verifyPost(post, anchor) {
    const text = window.FBSelect.extractText(post);
    const imageUrls = window.FBSelect.findImages(post);
    const panel = window.VerifyPanel.createPanel(anchor);

    if ((!text || text.length < 15) && imageUrls.length === 0) {
      panel.showError("This post has no text and no image to check.");
      return panel;
    }
    if (imageUrls.length === 0) panel.setStage("image", "done", "no image");

    panel.setStage(imageUrls.length ? "image" : "decompose", "active");

    let port;
    try {
      port = chrome.runtime.connect({ name: "verify" });
    } catch (e) {
      panel.showError("The extension background worker is not available. Reload the page.");
      return panel;
    }

    port.onMessage.addListener(function (msg) {
      if (!document.body.contains(panel.node)) {
        port.disconnect();
        return;
      }
      if (msg.type === "stage") {
        panel.completeThrough(msg.previous || null);
        panel.setStage(msg.stage, "active", msg.note);
      } else if (msg.type === "result") {
        panel.showResult(msg.result);
        port.disconnect();
      } else if (msg.type === "error") {
        panel.showError(msg.message);
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(function () {
      if (chrome.runtime.lastError) {
        panel.showError("The connection to the background worker closed.");
      }
    });

    port.postMessage({ type: "verify", text: text, imageUrls: imageUrls });
    return panel;
  }

  /**
   * Adds a Verify button to one post.
   * @param {Element} post
   */
  /**
   * Tells whether a node is actually visible to the reader.
   * @param {Element} node
   * @returns {boolean}
   */
  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 12) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

  /**
   * Builds the Verify button.
   * @returns {HTMLButtonElement}
   */
  function makeButton() {
    const btn = document.createElement("button");
    btn.className = "vf-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Check this post for misinformation");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
      '<path d="M4 2.75h6.5L15 7.25v3" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M10.25 2.9V7.5H14.8" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linejoin="round"/>' +
      '<path d="M4 2.75v14.5h4" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linejoin="round"/>' +
      '<circle cx="13" cy="13.5" r="3.3" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M15.5 16l2.2 2.2" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round"/></svg>';
    btn.appendChild(document.createTextNode("Verify"));
    return btn;
  }

  /**
   * Pins the button to the top right of the post.
   * This is the fallback when the action row cannot be found, or when the
   * button lands there but cannot be seen.
   * @param {Element} post
   * @param {HTMLButtonElement} btn
   */
  function pinToCorner(post, btn) {
    if (getComputedStyle(post).position === "static") {
      post.style.position = "relative";
    }
    btn.classList.add("vf-btn-corner");
    post.appendChild(btn);
  }

  /**
   * Adds a Verify button to one post, and makes sure it can be seen.
   * @param {Element} post
   * @returns {boolean} True if a button was placed.
   */
  function attachButton(post) {
    if (post.getAttribute(PROCESSED) === "1") return false;
    post.setAttribute(PROCESSED, "1");

    const mount = window.FBSelect.findMountPoint(post);
    const btn = makeButton();

    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      const open = document.querySelector(".vf-panel");
      if (open && open.__vfAnchor === btn) {
        open.__vfClose();
        return;
      }

      btn.disabled = true;
      try {
        const panel = verifyPost(post, btn);
        if (panel) panel.node.__vfAnchor = btn;
      } finally {
        setTimeout(function () { btn.disabled = false; }, 900);
      }
    });

    let how = mount.mode;
    if (mount.mode === "actionbar") {
      mount.host.appendChild(btn);
      // Facebook's own row may clip or squash it. Check, then move it if so.
      if (!isVisible(btn)) {
        btn.remove();
        pinToCorner(post, btn);
        how = "corner (row hid it)";
      }
    } else {
      pinToCorner(post, btn);
    }

    if (!isVisible(btn)) {
      how = "placed but not visible";
    }

    report.posts.push({
      how: how,
      text: window.FBSelect.extractText(post).slice(0, 60),
      images: window.FBSelect.findImages(post).length
    });
    report.placed += 1;
    return true;
  }

  /**
   * Scans the page and adds a button to every new post.
   * @returns {number} How many new buttons were placed.
   */
  function scan() {
    let count = 0;
    window.FBSelect.findPosts().forEach(function (p) {
      if (attachButton(p)) count += 1;
    });
    return count;
  }

  function start() {
    const found = scan();
    report.scans += 1;

    console.info(
      "[Verify] posts found: " + found + ". Buttons placed: " + report.placed +
      ". Run window.verifyReport() for detail."
    );

    // Facebook loads posts as you scroll, and it rebuilds them as you go.
    const feed = window.FBSelect.findFeed();
    const target = feed || document.body;
    const observer = new MutationObserver(function () {
      clearTimeout(start._timer);
      start._timer = setTimeout(function () {
        const added = scan();
        if (added) {
          report.scans += 1;
          console.info("[Verify] " + added + " more post(s) found.");
        }
      }, 400);
    });
    observer.observe(target, { childList: true, subtree: true });

    // The feed can arrive after the first scan. Keep looking for a while.
    let tries = 0;
    const poll = setInterval(function () {
      tries += 1;
      const more = scan();
      if (more) console.info("[Verify] " + more + " more post(s) found.");
      if (tries > 20) clearInterval(poll);
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
