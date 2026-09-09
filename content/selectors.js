/**
 * Facebook DOM adapter.
 *
 * Facebook obfuscates its class names and rewrites its markup often. All the
 * Facebook specific logic lives here, so there is one file to patch.
 *
 * Nothing here trusts a single shape. Each function tries the stable signals
 * first, which are the role and aria attributes Facebook needs for screen
 * readers, then falls back to structure, then reports that it found nothing.
 */
(function () {
  "use strict";

  const FBSelect = {};

  FBSelect.PROCESSED_ATTR = "data-verify-processed";

  /**
   * How Facebook labels the first post action.
   *
   * The labels are longer than they look: the comment button reads "Leave a
   * comment" and the share button reads "Send this to friends or post it on
   * your profile." So this matches the start of the label, not the whole of it.
   */
  const ACTION_LABEL_PATTERNS = [
    /^like$/i, /^react$/i, /^leave a comment/i, /^comment/i,
    /^send this to friends/i, /^share/i,
    /^मन पर्/, /^टिप्पणी/, /^सेयर/, /^कमेन्ट/
  ];

  /** The narrowest node we will treat as a post action row. */
  const MIN_ROW_WIDTH = 300;

  /**
   * Finds the buttons that carry a post action label.
   * @param {Element} scope
   * @returns {Element[]}
   */
  function actionButtons(scope) {
    return Array.from(scope.querySelectorAll('[role="button"][aria-label]'))
      .filter(function (b) {
        const label = b.getAttribute("aria-label") || "";
        return ACTION_LABEL_PATTERNS.some(function (re) { return re.test(label); });
      });
  }

  /**
   * Finds the feed container.
   *
   * Facebook does not always mark the feed with role="feed". On the current
   * home page it does not. So this also looks for the parent of the feed
   * items, which Facebook numbers with aria-posinset.
   *
   * @returns {Element|null}
   */
  FBSelect.findFeed = function () {
    const byRole = document.querySelector('[role="feed"]');
    if (byRole) return byRole;

    const item = document.querySelector("[aria-posinset]");
    if (item && item.parentElement) return item.parentElement;

    const main = document.querySelector('[role="main"]');
    if (main) return main;

    return null;
  };

  /**
   * Tells whether a node holds a post action row.
   * An empty feed slot has none, and neither does most page furniture.
   * @param {Element} node
   * @returns {boolean}
   */
  function hasActions(node) {
    if (node.querySelector('[role="toolbar"]')) return true;
    return actionButtons(node).length > 0;
  }

  /**
   * Finds the posts on the page.
   *
   * A permalink page has no feed, only one article, so this looks at the whole
   * document when there is no feed.
   *
   * @returns {Element[]} The posts. The list can be empty.
   */
  FBSelect.findPosts = function () {
    const root = document.querySelector('[role="main"]') || document.body;

    // Three ways to name a post, most reliable first.
    //   1. aria-posinset: Facebook numbers the feed items with it.
    //   2. role="article": used on a permalink page and in some views.
    //   3. the row of Like and Comment: walk up from it to the post.
    let candidates = Array.from(root.querySelectorAll("[aria-posinset]"));

    Array.from(root.querySelectorAll('[role="article"]')).forEach(function (node) {
      const parent = node.parentElement;
      if (parent && parent.closest('[role="article"]')) return;
      candidates.push(node);
    });

    if (!candidates.length) {
      Array.from(root.querySelectorAll('[role="toolbar"]')).forEach(function (bar) {
        const post = climbToPost(bar);
        if (post) candidates.push(post);
      });
    }

    // Keep the outermost candidate of any nest, so a comment or a shared post
    // does not become a second entry.
    candidates = candidates.filter(function (node) {
      return !candidates.some(function (other) {
        return other !== node && other.contains(node);
      });
    });

    // A post must carry something to check. A feed slot that Facebook has not
    // filled yet holds no text and no picture, so this drops it. An action row
    // is a good sign but not required: a photo view has none.
    return candidates.filter(function (node) {
      const hasText = FBSelect.extractText(node).length >= 20;
      const hasImage = FBSelect.findImages(node).length > 0;
      if (!hasText && !hasImage) return false;
      // A tiny node is furniture, not a post.
      const rect = node.getBoundingClientRect();
      return rect.width >= 200 || hasActions(node);
    });
  };

  /**
   * Walks up from an action row to the node that holds the whole post.
   * It stops when the node stops growing, which is the post card.
   * @param {Element} bar
   * @returns {Element|null}
   */
  function climbToPost(bar) {
    let node = bar;
    let best = null;
    let hops = 0;
    while (node && node !== document.body && hops < 25) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 300 && rect.height > 150) {
        best = node;
        // A post card is not much wider than the column, so stop growing.
        if (rect.height > 250) break;
      }
      node = node.parentElement;
      hops += 1;
    }
    return best;
  }

  /**
   * Reads the text of a post.
   * @param {Element} post
   * @returns {string} The post text. It can be empty.
   */
  /**
   * Tells whether a string is a machine token rather than something a person
   * wrote. Facebook hides such strings in a post, and they are long enough to
   * beat the caption when the longest block wins.
   * @param {string} text
   * @returns {boolean}
   */
  function looksLikeToken(text) {
    const t = text.trim();
    if (t.length < 16) return false;
    if (/\s/.test(t)) return false;
    // No spaces, and a mix of cases or digits: that is an identifier.
    return /[A-Za-z]/.test(t) && /[0-9A-Z]/.test(t) && !/^https?:/i.test(t);
  }

  /**
   * Opens a post that Facebook has folded behind "See more".
   *
   * Facebook does not keep the rest of the caption in the page, so a folded
   * post can only be read after the button is pressed. Only do this when the
   * reader has asked for a check.
   *
   * @param {Element} post
   * @returns {boolean} True if something was opened.
   */
  FBSelect.expandPost = function (post) {
    const buttons = Array.from(post.querySelectorAll('[role="button"]'));
    const more = buttons.find(function (b) {
      const label = ((b.innerText || "") + " " + (b.getAttribute("aria-label") || ""))
        .trim().toLowerCase();
      return /^see more$|see more$|थप हेर्नुहोस्|अझै हेर्नुहोस्/.test(label);
    });
    if (!more) return false;
    more.click();
    return true;
  };

  FBSelect.extractText = function (post) {
    const blocks = Array.from(post.querySelectorAll('div[dir="auto"], span[dir="auto"]'))
      .filter(function (b) {
        if (b.closest('[role="button"]')) return false;
        if (b.closest("form")) return false;
        // Never read our own panel or button back as post text.
        if (b.closest(".vf-btn") || b.closest(".vf-panel")) return false;
        // Facebook hides tokens and decoy text in the post. They are not
        // content, and they must not reach the model.
        if (b.closest('[aria-hidden="true"]')) return false;
        const rect = b.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        // Skip a block that only wraps other blocks.
        return !b.querySelector('div[dir="auto"]');
      })
      .map(function (b) { return (b.innerText || "").trim(); })
      .filter(function (t) { return t.length > 0 && !looksLikeToken(t); });

    if (blocks.length === 0) {
      const clone = post.cloneNode(true);
      Array.from(clone.querySelectorAll(".vf-btn, .vf-panel")).forEach(function (n) {
        n.remove();
      });
      return (clone.innerText || "").trim().slice(0, 2000);
    }

    blocks.sort(function (a, b) { return b.length - a.length; });
    return blocks[0].slice(0, 2000);
  };

  /**
   * Finds the images of a post.
   *
   * Most misinformation in Nepal travels as a graphic, so the image matters as
   * much as the caption. Small pictures are avatars and reaction icons.
   *
   * @param {Element} post
   * @returns {string[]} Up to three image URLs.
   */
  FBSelect.findImages = function (post) {
    const out = [];
    Array.from(post.querySelectorAll("img")).forEach(function (img) {
      const src = img.currentSrc || img.src || "";
      if (!src || src.startsWith("data:")) return;

      const rect = img.getBoundingClientRect();
      const w = img.naturalWidth || rect.width || 0;
      const h = img.naturalHeight || rect.height || 0;
      if (w < 180 || h < 180) return;
      if (img.closest('[role="button"]')) return;
      if (out.indexOf(src) === -1) out.push(src);
    });
    return out.slice(0, 3);
  };

  /**
   * Finds the row that holds Like, Comment and Share.
   * @param {Element} post
   * @returns {Element|null}
   */
  FBSelect.findActionBar = function (post) {
    // Facebook does mark a toolbar, but on the current feed that node is a
    // 21 pixel wrapper around one icon, not the row. So a toolbar only counts
    // when it is as wide as the post.
    const toolbar = post.querySelector('[role="toolbar"]');
    if (toolbar && toolbar.getBoundingClientRect().width >= MIN_ROW_WIDTH) {
      return toolbar;
    }

    // Otherwise climb from an action button to the first node as wide as the
    // post. That node is the row that holds Like, Comment and Share.
    const buttons = actionButtons(post);
    if (!buttons.length) return null;

    let node = buttons[0].parentElement;
    let hops = 0;
    while (node && node !== post && hops < 8) {
      const rect = node.getBoundingClientRect();
      if (rect.width >= MIN_ROW_WIDTH && node.querySelectorAll('[role="button"]').length >= 2) {
        return node;
      }
      node = node.parentElement;
      hops += 1;
    }

    return null;
  };

  /**
   * Chooses where to put the Verify button.
   * @param {Element} post
   * @returns {{host: Element, mode: string}}
   */
  FBSelect.findMountPoint = function (post) {
    const bar = FBSelect.findActionBar(post);
    if (bar) return { host: bar, mode: "actionbar" };
    return { host: post, mode: "corner" };
  };

  window.FBSelect = FBSelect;
})();
