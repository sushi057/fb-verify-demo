/**
 * Background service worker.
 *
 * It runs the whole verification here, in the browser. There is no server and
 * no terminal. The only thing it needs is a DeepSeek API key, which the user
 * types into the extension popup. The key is kept in this browser.
 */
import { SYSTEM_PROMPT, finishRun } from "./pipeline.js";
import { runDeepSeek } from "./deepseek.js";

const KEY_NAME = "deepseek_api_key";

/**
 * Reads the API key from browser storage.
 * @returns {Promise<string>}
 * @throws {Error} If no key is stored.
 */
async function loadKey() {
  const store = await chrome.storage.local.get(KEY_NAME);
  const key = (store[KEY_NAME] || "").trim();
  if (!key) {
    throw new Error(
      "No API key yet. Click the Verify icon in the toolbar and add your " +
      "DeepSeek API key."
    );
  }
  return key;
}

/**
 * Fetches one image and turns it into a data URL.
 * A content script cannot always read an image across origins, so the worker
 * does it.
 * @param {string} url
 * @returns {Promise<string|null>} Null if the image cannot be read.
 */
async function fetchImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 6 * 1024 * 1024) return null;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 8192) {
      binary += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    }
    const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
    return "data:" + type + ";base64," + btoa(binary);
  } catch (e) {
    return null;
  }
}

/**
 * Runs one verification.
 * @param {object} msg {text, imageUrls}
 * @param {function(object):void} report
 * @returns {Promise<object>} The result.
 */
async function verify(msg, report) {
  const key = await loadKey();

  const urls = (msg.imageUrls || []).slice(0, 3);
  const images = [];
  if (urls.length) {
    report({ type: "stage", stage: "image", note: "loading " + urls.length + " image(s)" });
    for (const u of urls) {
      const data = await fetchImage(u);
      if (data) images.push(data);
    }
  }

  const run = await runDeepSeek(SYSTEM_PROMPT, msg.text || "", images, report, key);

  return finishRun(
    run.finalText, run.retrieved, run.searchCount, "deepseek",
    report, run.headlines, run.windowStart, images.length
  );
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== "verify") return;

  let open = true;
  port.onDisconnect.addListener(function () { open = false; });

  function report(msg) {
    if (!open) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      open = false;
    }
  }

  port.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== "verify") return;
    verify(msg, report)
      .then(function (result) {
        if (open) port.postMessage({ type: "result", result: result });
      })
      .catch(function (err) {
        if (open) port.postMessage({ type: "error", message: err.message || String(err) });
      });
  });
});

// The popup asks whether a key is stored, so it can show the right screen.
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "has_key") {
    chrome.storage.local.get(KEY_NAME).then(function (s) {
      sendResponse({ hasKey: Boolean((s[KEY_NAME] || "").trim()) });
    });
    return true;
  }
  return false;
});
