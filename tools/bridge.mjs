#!/usr/bin/env node
/**
 * Local bridge and static server.
 *
 * It does two jobs:
 *   1. It serves the project files, so the harness can load its ES modules.
 *   2. It runs the verification pipeline at POST /verify.
 *
 * The model call runs through the "claude" command line tool. That tool is
 * already signed in with your Claude subscription, so no API key is needed
 * and no key is stored anywhere.
 *
 * Local use only. The server binds to localhost.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT, finishRun } from "../background/pipeline.js";
import { runDeepSeek } from "../background/deepseek.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 8777;
const MAX_TURNS = 14;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

/* ---------- image handling ---------- */

/**
 * Writes a data URL to a temporary file.
 * @param {string} dataUrl
 * @param {number} index
 * @returns {Promise<string>} The file path.
 * @throws {Error} If the data URL is not a supported image.
 */
async function writeImage(dataUrl, index) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Image " + (index + 1) + " is not a supported image data URL.");
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 6 * 1024 * 1024) {
    throw new Error("Image " + (index + 1) + " is larger than 6 MB.");
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "verify-img-"));
  const file = path.join(dir, "post-image-" + (index + 1) + "." + ext);
  await fsp.writeFile(file, buf);
  return file;
}

/* ---------- the model call ---------- */

/**
 * Runs the claude CLI and reports the stages.
 * @param {string} text The post caption. Can be empty.
 * @param {string[]} imagePaths Paths of the post images.
 * @param {function(object):void} emit Sends an event to the browser.
 * @returns {Promise<object>} The final result.
 */
function runClaude(text, imagePaths, emit) {
  return new Promise(function (resolve, reject) {
    const parts = [SYSTEM_PROMPT, "", "Today is " + new Date().toISOString().slice(0, 10) + "."];

    parts.push(
      "",
      "Your web search has no domain filter. Use site: filters to reach the",
      "allowlist, for example: site:nepalfactcheck.org <claim>"
    );
    if (imagePaths.length) {
      parts.push(
        "",
        "The post carries " + imagePaths.length + " image(s). Read each one with " +
        "the Read tool before you do anything else:"
      );
      imagePaths.forEach(function (p) { parts.push("  " + p); });
    }
    parts.push("", "<post_caption>", text || "(no caption; the claim is in the image)", "</post_caption>");

    const prompt = parts.join("\n");
    const tools = imagePaths.length ? "WebSearch,Read" : "WebSearch";

    const child = spawn("claude", [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--allowedTools", tools,
      "--max-turns", String(MAX_TURNS)
    ], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });

    const retrieved = new Map();
    const today = new Date().toISOString().slice(0, 10);
    let finalText = "";
    let stderr = "";
    let buffer = "";
    let searchCount = 0;
    let sawSearch = false;
    let sawImage = false;

    child.on("error", function (e) {
      reject(new Error(
        "The claude command could not start. Is Claude Code installed and on PATH? " + e.message
      ));
    });

    child.stderr.on("data", function (d) { stderr += d.toString(); });

    child.stdout.on("data", function (d) {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          continue;
        }

        if (msg.type === "assistant") {
          const blocks = (msg.message && msg.message.content) || [];
          blocks.forEach(function (blk) {
            if (blk.type !== "tool_use") return;
            if (blk.name === "Read" && !sawImage) {
              sawImage = true;
              emit({ type: "stage", stage: "image", note: "reading image" });
            }
            if (blk.name === "WebSearch") {
              if (!sawSearch) {
                sawSearch = true;
                emit({ type: "stage", stage: "retrieve", previous: "salience" });
              }
              searchCount += 1;
              const q = (blk.input && blk.input.query) || "";
              emit({ type: "query", query: q });
              emit({ type: "stage", stage: "retrieve", note: "search " + searchCount });
            }
          });
        } else if (msg.type === "user") {
          const blocks = (msg.message && msg.message.content) || [];
          blocks.forEach(function (blk) {
            if (!blk || blk.type !== "tool_result") return;
            const body = typeof blk.content === "string"
              ? blk.content
              : JSON.stringify(blk.content);
            // The WebSearch result carries a Links array of {title, url}.
            const m = /"?Links"?:\s*(\[[\s\S]*?\])/.exec(body);
            if (m) {
              let links;
              try {
                links = JSON.parse(m[1].replace(/\\"/g, '"'));
              } catch (e) {
                links = [];
              }
              links.forEach(function (l) {
                if (l && l.url) {
                  retrieved.set(l.url, { url: l.url, title: l.title || "", retrieved_at: today });
                }
              });
            } else {
              // Fall back to a plain URL scan of the result body.
              const urls = body.match(/https?:\/\/[^\s"'\\)\]]+/g) || [];
              urls.forEach(function (u) {
                retrieved.set(u, { url: u, title: "", retrieved_at: today });
              });
            }
            if (retrieved.size) {
              emit({ type: "stage", stage: "retrieve", note: retrieved.size + " pages" });
              emit({ type: "retrieved", count: retrieved.size });
            }
          });
        } else if (msg.type === "result") {
          finalText = msg.result || "";
          if (msg.is_error) {
            reject(new Error("The claude run failed: " + String(finalText).slice(0, 400)));
          }
        }
      }
    });

    child.on("close", function (code) {
      if (code !== 0 && !finalText) {
        reject(new Error(
          "The claude command exited with code " + code + ". " + stderr.slice(0, 400)
        ));
        return;
      }

      resolve({ finalText: finalText, retrieved: retrieved, searchCount: searchCount });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/* ---------- HTTP ---------- */

/**
 * Reads a JSON request body.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
  return new Promise(function (resolve, reject) {
    let data = "";
    req.on("data", function (c) {
      data += c;
      if (data.length > 40 * 1024 * 1024) {
        reject(new Error("The request body is too large."));
        req.destroy();
      }
    });
    req.on("end", function () {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(new Error("The request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function handleVerify(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "access-control-allow-origin": "*"
  });

  const send = function (obj) {
    res.write("data: " + JSON.stringify(obj) + "\n\n");
  };

  let tempFiles = [];
  try {
    const body = await readBody(req);
    const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    const text = String(body.text || "");
    const backend = body.backend === "claude" ? "claude" : "deepseek";

    let run;
    if (backend === "deepseek") {
      // DeepSeek takes the images inline. No temporary file is needed.
      run = await runDeepSeek(
        SYSTEM_PROMPT, text, images, send, process.env.DEEPSEEK_API_KEY);
    } else {
      for (let i = 0; i < images.length; i += 1) {
        tempFiles.push(await writeImage(images[i], i));
      }
      run = await runClaude(text, tempFiles, send);
    }

    const result = finishRun(
      run.finalText, run.retrieved, run.searchCount, backend, send,
      run.headlines, run.windowStart, images.length, run.searched);
    send({ type: "result", result: result });
  } catch (err) {
    send({ type: "error", message: err.message || String(err) });
  } finally {
    tempFiles.forEach(function (f) {
      fs.rm(path.dirname(f), { recursive: true, force: true }, function () {});
    });
    res.end();
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/tools/harness.html";
  const file = path.join(ROOT, rel);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, GET, OPTIONS"
    }).end();
    return;
  }
  if (req.method === "POST" && req.url.split("?")[0] === "/verify") {
    handleVerify(req, res);
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/health") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
      .end(JSON.stringify({
        ok: true,
        backends: {
          deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
          claude: true
        },
        default: "deepseek"
      }));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("Verify bridge on http://localhost:" + PORT);
  console.log("Harness:          http://localhost:" + PORT + "/tools/harness.html");
  console.log("Backends: deepseek (default)" +
    (process.env.DEEPSEEK_API_KEY ? " [key found]" : " [DEEPSEEK_API_KEY MISSING]") +
    ", claude [Claude Code sign in]");
});
