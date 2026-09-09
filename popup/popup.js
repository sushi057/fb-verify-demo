/** Popup: the only setup this extension needs is one API key. */
const KEY_NAME = "deepseek_api_key";
const $ = function (id) { return document.getElementById(id); };

/**
 * Shows whether a key is stored.
 * @param {boolean} hasKey
 */
function paint(hasKey) {
  const box = $("status");
  box.className = "status " + (hasKey ? "ok" : "no");
  $("statusText").textContent = hasKey ? "Key saved. Ready." : "No key yet.";
}

chrome.storage.local.get(KEY_NAME).then(function (s) {
  const key = (s[KEY_NAME] || "").trim();
  paint(Boolean(key));
  if (key) $("key").value = key;
});

$("save").addEventListener("click", async function () {
  const key = $("key").value.trim();
  if (!key) {
    $("statusText").textContent = "Type a key first.";
    return;
  }
  await chrome.storage.local.set({ [KEY_NAME]: key });
  paint(true);
  $("save").textContent = "Saved";
  setTimeout(function () { $("save").textContent = "Save key"; }, 1200);
});

$("clear").addEventListener("click", async function () {
  await chrome.storage.local.remove(KEY_NAME);
  $("key").value = "";
  paint(false);
});
