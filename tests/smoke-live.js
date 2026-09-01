/*
 * Live smoke test against the REAL Supabase backend configured in
 * script.js. No mock, no request blocking. Uses only a random private room
 * channel (the public global room is never messaged).
 *
 * Usage: node tests/smoke-live.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const PORT = 8895;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      const filePath =
        urlPath === "/__shell.html"
          ? path.join(__dirname, "shell.html")
          : path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      fs.readFile(filePath, (error, data) => {
        if (error) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "text/plain" });
        res.end(data);
      });
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`live smoke timeout: ${label}`);
}

(async () => {
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const failures = [];
  const check = (name, ok, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
    if (!ok) failures.push(name);
  };

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/__shell.html`, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(
      () =>
        window.frames.length >= 2 &&
        Array.from(window.frames).every((f) => f.document.getElementById("welcome-screen")),
      { timeout: 20000 }
    );
    const [A, B] = page.frames().filter((f) => f.url().endsWith("/"));

    const enter = async (f, name) => {
      await f.evaluate((n) => {
        document.getElementById("name-input").value = n;
        document.getElementById("start-button").click();
      }, name);
      await f.waitForFunction(
        () => document.getElementById("connection-text").textContent === "Connected",
        { timeout: 20000 }
      );
    };
    await enter(A, "SmokeA");
    check("host connects to live realtime", true);
    await enter(B, "SmokeB");
    check("joiner connects to live realtime", true);

    await A.evaluate(() => {
      document.getElementById("private-chat-tab").click();
      document.getElementById("create-room-button").click();
    });
    let code = "";
    await waitFor(async () => {
      code = await A.$eval("#room-code-label", (el) => el.textContent.trim());
      return /^[0-9]{4}$/.test(code);
    }, 15000, "room created on live backend");

    await B.evaluate((c) => {
      document.getElementById("private-chat-tab").click();
      document.getElementById("room-code-input").value = c;
      document.getElementById("join-room-button").click();
    }, code);
    await waitFor(async () => {
      return (await B.$eval("#room-status-text", (el) => el.textContent)).includes("2 people");
    }, 20000, "presence shows both members live");
    check("both members present via live presence", true);

    await A.evaluate(() => {
      document.getElementById("private-message-input").value = "live e2e probe";
    });
    await A.evaluate(() => document.getElementById("private-send-button").click());

    await waitFor(async () => {
      const rows = await B.$$eval("#private-message-list .private-message-row .message-text", (els) =>
        els.map((e) => e.textContent)
      );
      return rows.includes("live e2e probe");
    }, 20000, "message delivered over live backend");
    check("E2E message delivered through live Supabase", true);

    const wireOk = await A.evaluate(() =>
      JSON.stringify(window.__wireFrames || []).includes("probe") === false
    );
    check("no plaintext instrumentation leak (sanity)", wireOk);
  } catch (error) {
    check("live smoke completed", false, String(error.message));
  } finally {
    await browser.close().catch(() => {});
    server.close();
    console.log(failures.length ? `\nLIVE SMOKE FAILED (${failures.length})` : "\nLIVE SMOKE PASSED");
    process.exit(failures.length ? 1 : 0);
  }
})();
