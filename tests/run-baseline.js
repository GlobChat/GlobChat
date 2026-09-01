/*
 * GlobChat baseline test suite — Private Chat Rooms (4-digit codes).
 *
 * Architecture: the real app runs twice, in two same-origin iframes of a
 * single page. The mock Supabase transport (mock-transport.js) bridges
 * broadcast/presence traffic between frames via BroadcastChannel — fully
 * deterministic, no external network, no multi-renderer flakiness.
 *
 * Usage: node tests/run-baseline.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const PORT = 8899;
const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];

/* ------------------------- tiny test framework ------------------------ */

const results = [];
let suiteName = "";

function suite(name) {
  suiteName = name;
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ ok: true, suite: suiteName, name });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ ok: false, suite: suiteName, name, error: String(error.message || error) });
    console.log(`  ✗ ${name}\n      ${String(error.message || error).split("\n")[0]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function assertEqual(actual, expected, message) {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (actual !== expected) throw new Error(`${message || "values differ"}: expected ${e}, got ${a}`);
}

async function waitFor(fn, timeoutMs = 4000, label = "condition") {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(60);
  }
  if (lastError) throw lastError;
  throw new Error(`timeout waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * DOM-level click inside a frame. Semantically identical for these handlers
 * and immune to CDP raw-input stalls seen in this sandbox.
 */
async function setValue(frame, selector, value) {
  await frame.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`element missing: ${sel}`);
      el.value = val;
    },
    selector,
    value
  );
}

async function click(frame, selector) {
  await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`element missing: ${sel}`);
    el.click();
  }, selector);
}

/* ----------------------------- static server -------------------------- */

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json"
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // When hardMode is on the server answers every conditional request
      // with a full 200 — the wire signature of a cache-bypassed hard
      // refresh. Used by the hard-refresh persistence test.
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      let filePath =
        urlPath === "/__shell.html"
          ? path.join(__dirname, "shell.html")
          : path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }

      fs.stat(filePath, (statErr, stats) => {
        if (statErr) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        fs.readFile(filePath, (readErr, data) => {
          if (readErr) {
            res.writeHead(404);
            res.end("not found");
            return;
          }

          // Validators + long-lived freshness: a soft reload either serves
          // from cache (transferSize 0) or revalidates to a 304
          // (decodedBodySize 0) — both classify as "soft" to the probe. A
          // hard refresh bypasses cache and receives the full body ("hard").
          const etag = 'W/' + data.length + '-' + Math.floor(stats.mtimeMs);
          const headers = {
            "Content-Type": MIME[path.extname(filePath)] || "text/plain",
            // no-cache = "store but revalidate every time": soft reloads
            // revalidate (If-None-Match → 304 → empty body), hard refreshes
            // bypass the cache entirely (200 + full body).
            "Cache-Control": "no-cache",
            ETag: etag,
            Date: new Date().toUTCString()
          };

          const isValidatorReq =
            Boolean(req.headers["if-none-match"]) && server.hardMode !== true;
          if (process.env.GC_SERVER_DEBUG && (urlPath === "/" || urlPath.startsWith("/?"))) {
            console.log(
              `  [srv] ${req.url} INM=${req.headers["if-none-match"] || "none"} → ${isValidatorReq ? 304 : 200}`
            );
          }
          if (isValidatorReq) {
            res.writeHead(304, headers);
            res.end();
            return;
          }
          res.writeHead(200, headers);
          res.end(data);
        });
      });
    });

    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ------------------------------ frame helpers ------------------------- */

const MOCK_SOURCE = fs.readFileSync(path.join(__dirname, "mock-transport.js"), "utf8");

async function getClientFrames(browser) {
  const page = await browser.newPage();

  page.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[globchat]")) console.log(`  [app] ${text}`);
  });

  // NOTE: no request interception and no Network.enable here — both disrupt
  // Chrome's cache semantics in headless, which the soft-reload probe depends
  // on. The real supabase-js CDN build is neutralized inside the page by the
  // mock (window.supabase is locked non-writable).

  // Inject the mock into every document of the page (parent + iframes).
  await page.evaluateOnNewDocument(MOCK_SOURCE);

  await page.goto(`http://127.0.0.1:${PORT}/__shell.html`, { waitUntil: "domcontentloaded" });

  // Wait until both app frames are live.
  await page.waitForFunction(
    () =>
      window.frames.length >= 2 &&
      Array.from(window.frames).every(
        (f) => f.document && f.document.getElementById("welcome-screen")
      ),
    { timeout: 8000 }
  );

  const frames = page.frames().filter((f) => {
    try {
      return new URL(f.url()).pathname === "/";
    } catch (_) {
      return false;
    }
  });
  if (frames.length < 2) throw new Error("app frames not found");

  // Deterministic order: client-a first.
  frames.sort((a, b) => {
    const order = { "client-a": 0, "client-b": 1 };
    return 0;
  });
  const byId = await Promise.all(
    ["#client-a", "#client-b"].map((sel) =>
      page.$eval(sel, (el) => el.name).then(() => null).catch(() => null)
    )
  );

  // Match frames to their host element ids via evaluation.
  const tagged = [];
  for (const frame of frames) {
    const tag = await frame.evaluate((w) => {
      return w.frameElement ? w.frameElement.id : "unknown";
    }).catch(() => "unknown");
    tagged.push({ frame, tag });
  }
  tagged.sort((a, b) => (a.tag === "client-a" ? -1 : 1));

  return { page, frames: tagged.map((t) => t.frame) };
}

async function enterChat(frame, name) {
  await frame.waitForSelector("#welcome-screen:not(.hidden)", { timeout: 5000 });
  await setValue(frame, "#name-input", name);
  await click(frame, "#start-button");
  await frame.waitForFunction(
    () =>
      !document.getElementById("chat-screen").classList.contains("hidden") &&
      document.getElementById("connection-text").textContent === "Connected",
    { timeout: 6000 }
  );
}

async function openPrivateTab(frame) {
  await click(frame, "#private-chat-tab");
  await frame.waitForFunction(
    () => !document.getElementById("private-chat-panel").classList.contains("hidden")
  );
}

function roomCode(frame) {
  return frame.$eval("#room-code-label", (el) => el.textContent.trim());
}

async function sendRoomMessage(frame, text) {
  // Respect the app's client-side rate limit exactly like a real user.
  await sleep(1000);
  await frame.evaluate((value) => {
    document.getElementById("private-message-input").value = value;
  }, text);
  await click(frame, "#private-send-button");
}

/* Failure diagnostics: surface toasts + room/channel state. */
async function dumpState(label, frames) {
  for (let i = 0; i < frames.length; i += 1) {
    const info = await frames[i]
      .evaluate(() => ({
        toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent),
        joinError: document.getElementById("join-room-error")
          ? document.getElementById("join-room-error").textContent
          : null,
        rows: document.querySelectorAll("#private-message-list .private-message-row").length,
        activeCode: typeof activeRoomCode !== "undefined" ? activeRoomCode : null,
        rooms:
          typeof privateRooms !== "undefined"
            ? Array.from(privateRooms.entries()).map(
                ([k, r]) => `${k}(sub:${r.subscribed},key:${Boolean(r.key)},unread:${r.unread})`
              )
            : [],
        wire: (window.__wireFrames || []).map((x) => `${x.channel.slice(-8)}:${x.event}`)
      }))
      .catch((e) => ({ err: String(e.message) }));
    console.log(`  [diag ${label} client${i}]`, JSON.stringify(info));
  }
}

function visibleRows(frame) {
  return frame.$$eval("#private-message-list .private-message-row", (rows) =>
    rows.map((row) => ({
      own: row.classList.contains("is-own-message"),
      text: row.querySelector(".message-text")?.textContent ?? "",
      name: row.querySelector(".message-name")?.textContent ?? ""
    }))
  );
}

async function wireCount(frame) {
  return frame.evaluate(() => window.__wireFrames.length);
}

async function clearWireLog(frame) {
  await frame.evaluate(() => {
    window.__wireFrames.length = 0;
  });
}

async function getLastPrivateWireFrame(frame) {
  return frame.evaluate(() => {
    for (let i = window.__wireFrames.length - 1; i >= 0; i -= 1) {
      const f = window.__wireFrames[i];
      if (f.channel.startsWith("private-chat:room-")) return f;
    }
    return null;
  });
}

/* --------------------------------- suite ------------------------------ */

(async () => {
  setTimeout(() => {
    console.log("\n[WATCHDOG] hard limit reached");
    process.exit(3);
  }, 90000);

  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) {
    console.error("No Chrome/Chromium binary found");
    process.exit(1);
  }

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  try {
    const { page: hostPage, frames } = await getClientFrames(browser);
    if (!frames || frames.length < 2) throw new Error("frames unavailable");
    const [alice, bob] = frames;

    /* ---------------------- crypto unit checks ---------------------- */
    suite("crypto primitives");

    await test("generateRoomCode yields unambiguous alphanumeric codes", async () => {
      const ok = await alice.evaluate(() => {
        const ambiguous = /[0O1IL]/;
        for (let i = 0; i < 200; i += 1) {
          const code = generateRoomCode();
          if (!/^[A-Z0-9]{4}$/.test(code)) return false;
          if (ambiguous.test(code)) return false;
        }
        return true;
      });
      assert(ok, "some generated code was invalid");
    });

    await test("PBKDF2 derivation is deterministic per code+salt", async () => {
      const ok = await alice.evaluate(async () => {
        const salt = btoa("0123456789abcdef");
        const a = await deriveRoomKey("1234", salt);
        const b = await deriveRoomKey("1234", salt);
        const c = await deriveRoomKey("9999", salt);

        const probe = { m: "roundtrip" };
        const ct = await encryptPrivatePayload(a, probe);
        const backA = await decryptPrivatePayload(b, ct);
        let rejected = false;
        try {
          await decryptPrivatePayload(c, ct);
        } catch (_) {
          rejected = true;
        }
        return backA.m === "roundtrip" && rejected;
      });
      assert(ok, "key equivalence / rejection check failed");
    });

    await test("tampered ciphertext fails AES-GCM authentication", async () => {
      const ok = await alice.evaluate(async () => {
        const key = await deriveRoomKey("1111", btoa("0123456789abcdef"));
        const ct = await encryptPrivatePayload(key, { m: "secret" });
        const bytes = Uint8Array.from(atob(ct), (ch) => ch.charCodeAt(0));
        bytes[bytes.length - 1] ^= 0xff; // flip one bit
        const tampered = btoa(String.fromCharCode(...bytes));
        try {
          await decryptPrivatePayload(key, tampered);
          return false;
        } catch (_) {
          return true;
        }
      });
      assert(ok, "tampered frame was accepted");
    });

    /* --------------------- multi-client scenarios -------------------- */
    suite("baseline & global chat regression");

    await test("welcome screen renders for both clients", async () => {
      for (const frame of [alice, bob]) {
        await frame.waitForSelector("#welcome-screen:not(.hidden)");
      }
    });

    await test("entering chat connects both clients", async () => {
      await enterChat(alice, "Alice");
      await enterChat(bob, "Bob");
    });

    await test("online count reaches 2 via presence", async () => {
      await waitFor(async () =>
        (await alice.$eval("#online-count", (el) => el.textContent)) === "2"
      );
      assert(true);
    });

    await test("global message flows Alice → Bob (regression)", async () => {
      await alice.evaluate(() => {
        document.getElementById("message-input").value = "global ping";
      });
      await click(alice, "#send-button");
      await waitFor(async () => {
        const texts = await bob.$$eval("#message-list .message-row .message-text", (els) =>
          els.map((e) => e.textContent)
        );
        return texts.includes("global ping");
      }, 4000, "bob receiving global ping");
      assert(true);
    });

    suite("room creation & joining");

    await test("private tab shows start view with create/join controls", async () => {
      await openPrivateTab(alice);
      const hasCreate = await alice.$("#create-room-button:not(.hidden)");
      const hasJoinInput = await alice.$("#room-code-input");
      assert(hasCreate && hasJoinInput, "create/join controls missing");
    });

    let sharedCode = "";
    let presenceCode = "";
    await test("Alice creates a room and receives a 4-character code", async () => {
      await click(alice, "#create-room-button");
      await waitFor(async () => {
        const title = await alice.$eval("#room-title", (el) => el.textContent);
        return /^Room [A-Z0-9]{4}$/.test(title);
      }, 4000, "room header with code");
      sharedCode = await roomCode(alice);
      assert(/^[A-Z0-9]{4}$/.test(sharedCode), `bad code format: ${sharedCode}`);

      const threadVisible = await alice.$eval("#private-thread-active", (el) =>
        !el.classList.contains("hidden")
      );
      assert(threadVisible, "thread not visible after create");
    });

    await test("creator's status becomes connected · encrypted", async () => {
      await waitFor(async () => {
        const state = await alice.$eval("#room-status", (el) => el.dataset.state);
        return state === "connected";
      });
      assert(true);
    });

    await test("sidebar lists the created room", async () => {
      await waitFor(async () => {
        const items = await alice.$$eval("#conversation-list .private-item-name", (els) =>
          els.map((e) => e.textContent)
        );
        return items.some((t) => t === `Room ${sharedCode}`);
      });
      assert(true);
    });

    await test("Bob joins by entering the 4-character code", async () => {
      await openPrivateTab(bob);
      await setValue(bob, "#room-code-input", sharedCode);
      await click(bob, "#join-room-button");
      await waitFor(async () => {
        const code = await roomCode(bob);
        return code === sharedCode;
      }, 4000, "bob room code match");
    });

    await test("member count shows 2 people in header on both sides", async () => {
      await waitFor(async () => {
        const t = await alice.$eval("#room-status-text", (el) => el.textContent);
        return t.includes("2 people");
      });
      await waitFor(async () => {
        const t = await bob.$eval("#room-status-text", (el) => el.textContent);
        return t.includes("2 people");
      });
      assert(true);
    });

    suite("encrypted messaging over the wire");

    let wireFrame = null;
    await test("message delivers E2E while wire carries only ciphertext", async () => {
      await clearWireLog(alice);
      await sendRoomMessage(alice, "hello private world");
      try {
        await waitFor(async () => {
          const rows = await visibleRows(bob);
          return rows.length > 0 && rows[rows.length - 1].text === "hello private world";
        }, 4000, "bob receiving private message");
      } catch (error) {
        await dumpState("e2e-delivery", [alice, bob]);
        throw error;
      }
      assert(true);

      wireFrame = await getLastPrivateWireFrame(alice);
      assert(wireFrame, "no wire frame captured");
      const payload = wireFrame.payload;
      assertEqual(payload.v, 1, "frame version");
      assert(typeof payload.s === "string" && payload.s.length > 0, "salt missing on wire");
      assert(!JSON.stringify(payload).includes("hello private world"), "plaintext leaked on wire!");
      assert(!JSON.stringify(payload.s + payload.ct).includes("Alice"), "sender name leaked on wire!");
    });

    await test("sender sees own message via echo, marked as own", async () => {
      const rows = await visibleRows(alice);
      const last = rows[rows.length - 1];
      assert(last.text === "hello private world", "echo missing");
      assert(last.own === true, "own styling missing");
    });

    await test("receiver's copy shows sender name and is not styled as own", async () => {
      const rows = await visibleRows(bob);
      const last = rows[rows.length - 1];
      assert(last.name === "Alice", `expected sender name Alice, got ${last.name}`);
      assert(last.own === false, "should not be own-styled");
    });

    await test("reply flows Bob → Alice", async () => {
      await sendRoomMessage(bob, "hi alice, secured");
      try {
        await waitFor(async () => {
          const rows = await visibleRows(alice);
          return rows[rows.length - 1]?.text === "hi alice, secured";
        }, 4000, "alice receiving reply");
      } catch (error) {
        await dumpState("reply", [alice, bob]);
        throw error;
      }
      const lastOwn = await alice.$eval(
        "#private-message-list .private-message-row:last-child",
        (el) => el.classList.contains("is-own-message")
      );
      assert(lastOwn === false, "incoming reply wrongly styled as own");
    });

    suite("input validation & abuse controls");

    await test("empty message is blocked (no frame sent)", async () => {
      const before = await wireCount(alice);
      await sendRoomMessage(alice, "");
      await sleep(150);
      const after = await wireCount(alice);
      assertEqual(after, before, "empty message must not hit the wire");
    });

    await test("rate limit blocks rapid second send", async () => {
      await sendRoomMessage(alice, "one");
      const before = await wireCount(alice);
      // Immediate second attempt: no pacing helper on purpose.
      await setValue(alice, "#private-message-input", "two");
      await click(alice, "#private-send-button");
      await sleep(150);
      const after = await wireCount(alice);
      assertEqual(after, before, "rate-limited message must not hit the wire");
    });

    await test("oversized message is truncated to the technical cap", async () => {
      const big = "x".repeat(25000);
      await clearWireLog(alice);
      await sendRoomMessage(alice, big);
      await waitFor(async () => {
        const rows = await visibleRows(bob);
        return rows[rows.length - 1]?.text?.length === 20000;
      }, 5000, "truncated delivery");
      const frame = await getLastPrivateWireFrame(alice);
      assert(frame.payload.ct.length < 20000 * 2 + 64 + 100, "ciphertext unexpectedly large");
      await sleep(950);
    });

    suite("adversarial frames");

    await test("forged garbage ciphertext from a third party is dropped", async () => {
      const beforeBob = await visibleRows(bob);
      await bob.evaluate((channelName) => {
        window.__mockRawSend(channelName, "private-message", {
          v: 1,
          id: "forged-1",
          s: btoa("attacker-salt-16"),
          ct: btoa("garbage-not-ciphertext")
        });
      }, `private-chat:room-${sharedCode}`);
      await sleep(250);
      const afterBob = await visibleRows(bob);
      assertEqual(afterBob.length, beforeBob.length, "forged frame must be dropped");
    });

    await test("replayed frame (duplicate id) is deduplicated", async () => {
      const before = await visibleRows(bob);
      await bob.evaluate((frame) => {
        window.__mockRawSend(frame.channel, frame.event, frame.payload);
      }, wireFrame);
      await sleep(250);
      const after = await visibleRows(bob);
      assertEqual(after.length, before.length, "replayed frame must not render twice");
    });

    await test("XSS payload renders as inert text", async () => {
      await bob.evaluate(() => {
        window.__pwned = false;
      });
      await sleep(950); // rate-limit window
      await sendRoomMessage(alice, '<img src=x onerror="window.__pwned=true">');
      await waitFor(async () => {
        const rows = await visibleRows(bob);
        return rows[rows.length - 1]?.text?.includes("<img src=x");
      }, 4000, "xss payload as text");
      const pwned = await bob.evaluate(() => window.__pwned);
      const imgCount = await bob.$$eval("#private-message-list img", (els) => els.length);
      assert(pwned === false, "onerror executed — XSS vulnerability!");
      assertEqual(imgCount, 0, "img element was created — XSS vulnerability!");
      await sleep(950);
    });

    suite("unread indicators");

    await test("message while on global tab raises tab badge", async () => {
      await click(bob, "#global-chat-tab");
      await sleep(950);
      await sendRoomMessage(alice, "badge me");
      await waitFor(async () => {
        const badgeText = await bob.$eval("#private-unread-badge", (el) => el.textContent);
        const hidden = await bob.$eval("#private-unread-badge", (el) =>
          el.classList.contains("hidden")
        );
        return badgeText === "1" && !hidden;
      }, 4000, "badge increment");
      assert(true);
    });

    await test("opening the room clears the unread badge", async () => {
      await click(bob, "#private-chat-tab");
      await bob.evaluate((code) => openRoom(code), sharedCode);
      await waitFor(async () => {
        const hidden = await bob.$eval("#private-unread-badge", (el) =>
          el.classList.contains("hidden")
        );
        return hidden;
      });
      assert(true);
    });

    suite("room names & notification sound");

    await test("named room shows custom name for creator", async () => {
      await sleep(950);
      await click(alice, "#new-room-button");
      await setValue(alice, "#room-name-input", "Weekend Squad");
      await click(alice, "#create-room-button");
      await waitFor(async () => {
        const title = await alice.$eval("#room-title", (el) => el.textContent);
        return title === "Weekend Squad";
      }, 4000, "creator header shows room name");
      const code = await roomCode(alice);
      assert(/^[A-Z0-9]{4}$/.test(code), "code still available for sharing");
    });

    await test("joiner learns the room name via meta frame", async () => {
      const code = await roomCode(alice);
      await openPrivateTab(bob);
      await setValue(bob, "#room-code-input", code);
      await click(bob, "#join-room-button");
      await waitFor(async () => {
        const title = await bob.$eval("#room-title", (el) => el.textContent);
        return title === "Weekend Squad";
      }, 6000, "joiner header shows room name");
      const sidebarNamed = await bob.$$eval("#conversation-list .private-item-name", (els) =>
        els.map((e) => e.textContent)
      );
      assert(sidebarNamed.includes("Weekend Squad"), "sidebar shows room name");
    });

    await test("notification sound fires for unread private messages", async () => {
      // Put bob on the global tab so the next message is unread.
      await click(bob, "#global-chat-tab");
      await bob.evaluate(() => {
        window.__soundCount = 0;
        playNotificationSound = () => {
          window.__soundCount += 1;
        };
      });
      await sendRoomMessage(alice, "ding test");
      await waitFor(async () => {
        const count = await bob.evaluate(() => window.__soundCount);
        return count >= 1;
      }, 4000, "sound hook invoked");
      assert(true);
    });

    suite("presence, member list & expiry");

    await test("join/leave system notices appear for both sides", async () => {
      await sleep(950);
      await click(alice, "#new-room-button");
      await click(alice, "#create-room-button");
      await waitFor(async () => {
        const title = await alice.$eval("#room-title", (el) => el.textContent);
        return /^Room [A-Z0-9]{4}$/.test(title);
      }, 4000, "presence room created");
      presenceCode = await roomCode(alice);

      await setValue(bob, "#room-code-input", presenceCode);
      await click(bob, "#join-room-button");
      await waitFor(async () => (await roomCode(bob)) === presenceCode, 4000, "bob joined");

      // Alice should see "Bob joined the room".
      await waitFor(async () => {
        const texts = await alice.$$eval(
          "#private-message-list .system-row-text",
          (els) => els.map((e) => e.textContent)
        );
        return texts.some((t) => t === "Bob joined the room");
      }, 4000, "alice join notice");
      assert(true);
    });

    await test("member list shows everyone with a you-marker", async () => {
      await click(alice, "#room-members-button");
      await waitFor(async () =>
        !(await alice.$eval("#room-members-panel", (el) => el.classList.contains("hidden")))
      );
      const names = await alice.$$eval("#room-members-list .room-member-item", (els) =>
        els.map((e) => e.textContent)
      );
      assert(names.length === 2, `expected 2 members, got ${names.length}`);
      assert(
        names.some((n) => n.includes("Alice") && n.includes("you")),
        "self marker missing"
      );
      assert(names.some((n) => n.includes("Bob")), "bob missing from member list");
      await click(alice, "#room-members-button"); // close panel
    });

    await test("empty rooms auto-expire (expiry check)", async () => {
      const expiredBefore = await alice.evaluate(() => privateRooms.size);
      // Age the room past its expiry, then run the checker directly.
      const removed = await alice.evaluate((code) => {
        const room = privateRooms.get(code);
        if (!room) return -1;
        room.emptySince = Date.now() - ROOM_EMPTY_EXPIRY_MS - 1000;
        return checkRoomExpiries();
      }, presenceCode);
      assert(removed >= 1, "expiry checker removed nothing");
      const expiredAfter = await alice.evaluate(() => privateRooms.size);
      assert(expiredAfter === expiredBefore - 1, "room not removed");
    });

    suite("multi-room isolation");

    await test("second room stays isolated from first", async () => {
      await click(alice, "#new-room-button");
      await click(alice, "#create-room-button");
      await waitFor(async () => {
        const title = await alice.$eval("#room-title", (el) => el.textContent);
        return /^Room [A-Z0-9]{4}$/.test(title) && !title.includes(sharedCode);
      }, 4000, "second room opened");
      const secondCode = await roomCode(alice);
      assert(secondCode !== sharedCode, "codes should differ");

      await sendRoomMessage(alice, "secret for room two");
      await sleep(300);

      // Switch back to room one on Alice: transcript restored from cache,
      // no cross-room bleed.
      await alice.evaluate((code) => openRoom(code), sharedCode);
      const texts = await alice.$$eval(
        "#private-message-list .private-message-row .message-text",
        (els) => els.map((e) => e.textContent)
      );
      assert(!texts.includes("secret for room two"), "cross-room bleed detected!");
      assert(texts.includes("hello private world"), "cached history lost");
      await sleep(950);
    });

    suite("membership lifecycle");

    await test("Bob leaves the room; Alice's count drops to 1", async () => {
      await bob.evaluate((code) => {
        const room = privateRooms.get(code);
        if (room) leaveRoom(room);
        showStartView();
      }, sharedCode);
      await waitFor(async () => {
        const t = await alice.$eval("#room-status-text", (el) => el.textContent);
        return !t.includes("2 people");
      }, 4000, "alice observing departure");
      assert(true);
    });

    await test("rejoin with code starts empty but adopts salt from live traffic", async () => {
      await setValue(bob, "#room-code-input", sharedCode);
      await click(bob, "#join-room-button");
      await waitFor(async () => (await roomCode(bob)) === sharedCode, 4000, "rejoined");

      // Fresh join may already carry system notices (join/leave) — what it
      // must NOT have is any real message row.
      const messageRows = await bob.$$eval("#private-message-list .private-message-row", (els) => els.length);
      assertEqual(messageRows, 0, "fresh join should have no message rows");

      await sleep(950);
      await sendRoomMessage(alice, "post rejoin hello");
      await waitFor(async () => {
        const rows = await visibleRows(bob);
        return rows[rows.length - 1]?.text === "post rejoin hello";
      }, 4000, "late joiner decrypting via adopted salt");
      assert(true);
    });

    suite("teardown");

    await test("leaving chat wipes all room state", async () => {
      await click(alice, "#leave-button");
      await alice.waitForSelector("#welcome-screen:not(.hidden)");
      const size = await alice.evaluate(() => privateRooms.size);
      assertEqual(size, 0, "rooms not cleared on leave");
    });

    suite("soft-reload persistence");

    async function reacquireFrames() {
      const framesNow = hostPage.frames().filter((f) => {
        try {
          return new URL(f.url()).pathname === "/";
        } catch (_) {
          return false;
        }
      });
      const tagged = [];
      for (const frame of framesNow) {
        const tag = await frame
          .evaluate(() => (window.frameElement ? window.frameElement.id : "unknown"))
          .catch(() => "unknown");
        tagged.push({ frame, tag });
      }
      tagged.sort((a, b) => (a.tag === "client-a" ? -1 : 1));
      return tagged.map((t) => t.frame);
    }

    let aFrame = null;
    let bFrame = null;
    let persistCode = "";
    let preReload = null;

    await test("setup: fresh chat, room, and seeded transcript", async () => {
      [aFrame, bFrame] = await reacquireFrames();

      // Alice re-enters (previous suite left her on the welcome screen).
      await setValue(aFrame, "#name-input", "Alice");
      await click(aFrame, "#start-button");
      await aFrame.waitForFunction(
        () => document.getElementById("connection-text").textContent === "Connected",
        { timeout: 8000 }
      );

      await openPrivateTab(aFrame);
      await click(aFrame, "#create-room-button");
      await waitFor(async () => {
        const title = await aFrame.$eval("#room-title", (el) => el.textContent);
        return /^Room [A-Z0-9]{4}$/.test(title);
      }, 4000, "persistence room created");
      persistCode = await roomCode(aFrame);

      // Bob joins the same room (his frame has never reloaded).
      await setValue(bFrame, "#room-code-input", persistCode);
      await click(bFrame, "#join-room-button");
      await waitFor(async () => (await roomCode(bFrame)) === persistCode, 4000, "bob joined");

      await sendRoomMessage(aFrame, "pre-reload message");
      await waitFor(async () => {
        const rows = await visibleRows(bFrame);
        return rows[rows.length - 1]?.text === "pre-reload message";
      }, 4000, "seed message delivered");
    });

    await test("state snapshot before reload", async () => {
      preReload = await aFrame.evaluate(() => {
        const room = Array.from(privateRooms.values())[0];
        return {
          name: currentName,
          roomCount: privateRooms.size,
          transcript: room ? (room.transcript || []).map((r) => r.m) : [],
          globalRows: document.querySelectorAll("#message-list .message-row").length
        };
      });
      assertEqual(preReload.name, "Alice", "snapshot name");
      assertEqual(preReload.roomCount, 1, "snapshot rooms");
      assert(preReload.transcript.includes("pre-reload message"), "snapshot transcript");
    });

    await test("soft reload (F5) restores name, rooms and transcripts", async () => {
      await aFrame
        .evaluate(() => {
          setTimeout(() => location.reload(), 0);
        })
        .catch(() => {});

      await sleep(1200);
      [aFrame, bFrame] = await reacquireFrames();

      await aFrame.waitForFunction(
        () =>
          document.getElementById("welcome-screen").classList.contains("hidden") &&
          !document.getElementById("chat-screen").classList.contains("hidden") &&
          document.getElementById("connection-text").textContent === "Connected",
        { timeout: 10000 }
      );

      const restored = await aFrame.evaluate(() => {
        const room = Array.from(privateRooms.values())[0];
        return {
          name: currentName,
          roomCount: privateRooms.size,
          transcript: room ? (room.transcript || []).map((r) => r.m) : [],
          sidebarItems: document.querySelectorAll("#conversation-list .private-item").length,
          savedRaw: sessionStorage.getItem("globchat.session.v1")
        };
      });
      console.log("  [diag] restored:", JSON.stringify({
        transcript: restored.transcript,
        savedRooms: restored.savedRaw ? JSON.parse(restored.savedRaw).rooms : null
      }));

      assertEqual(restored.name, "Alice", "name restored");
      assertEqual(restored.roomCount, preReload.roomCount, "room count restored");
      assert(restored.transcript.includes("pre-reload message"), "transcript restored");
      assertEqual(restored.transcript.length, preReload.transcript.length, "transcript length");
      assert(restored.sidebarItems >= 1, "sidebar restored");
    });

    await test("restored session still receives live messages (re-derived key)", async () => {
      await sendRoomMessage(bFrame, "post-reload delivery check");
      await waitFor(async () => {
        const rows = await visibleRows(aFrame);
        return rows[rows.length - 1]?.text === "post-reload delivery check";
      }, 4000, "post-reload message received");
      assert(true);
    });

    await test("hard refresh (cache bypassed) wipes everything", async () => {
      // A hard refresh bypasses the HTTP cache: the document arrives as a
      // full 200 instead of a 304 revalidation. hardMode makes the test
      // server produce exactly that wire signature; the frame must then
      // classify the load as hard and wipe.
      server.hardMode = true;
      await aFrame
        .evaluate(() => {
          setTimeout(() => location.reload(), 0);
        })
        .catch(() => {});
      await sleep(2000);
      [aFrame, bFrame] = await reacquireFrames();
      server.hardMode = false;

      await aFrame.waitForFunction(
        () => !document.getElementById("welcome-screen").classList.contains("hidden"),
        { timeout: 10000 }
      );
      const roomsLeft = await aFrame.evaluate(() =>
        typeof privateRooms !== "undefined" ? privateRooms.size : -1
      );
      assertEqual(roomsLeft, 0, "hard refresh must not restore rooms");
    });

    await test("cleared session storage (simulates tab close) starts clean", async () => {
      // Re-enter to build state, then wipe storage and reload.
      const onWelcome = await aFrame.$eval("#welcome-screen", (el) =>
        !el.classList.contains("hidden")
      );
      if (!onWelcome) {
        await click(aFrame, "#leave-button");
        await sleep(400);
      }
      await setValue(aFrame, "#name-input", "Alice");
      await click(aFrame, "#start-button");
      await aFrame.waitForFunction(
        () => document.getElementById("connection-text").textContent === "Connected",
        { timeout: 8000 }
      );
      await aFrame.evaluate(() => {
        // Simulate a tab close: storage dies AND the dying page must not
        // flush a fresh snapshot from its pagehide handler (a real tab
        // close destroys memory before any flush can matter).
        sessionStorage.clear();
        currentName = "";
      });
      await aFrame
        .evaluate(() => {
          setTimeout(() => location.reload(), 0);
        })
        .catch(() => {});
      await sleep(1500);
      [aFrame, bFrame] = await reacquireFrames();
      await aFrame.waitForFunction(
        () => !document.getElementById("welcome-screen").classList.contains("hidden"),
        { timeout: 10000 }
      );
      const roomsLeft = await aFrame.evaluate(() =>
        typeof privateRooms !== "undefined" ? privateRooms.size : 0
      );
      assertEqual(roomsLeft, 0, "no rooms after storage wipe");
    });

    /* ---------------------------- summary ---------------------------- */
    const failed = results.filter((r) => !r.ok);
    console.log("\n──────────────────────────────");
    console.log(`TOTAL ${results.length} · PASSED ${results.length - failed.length} · FAILED ${failed.length}`);
    if (failed.length) {
      console.log("\nFailures:");
      failed.forEach((f) => console.log(` ✗ [${f.suite}] ${f.name}: ${f.error}`));
    }
    process.exitCode = failed.length ? 1 : 0;
  } catch (fatal) {
    console.error("FATAL:", fatal && (fatal.stack || fatal.message || fatal));
    process.exitCode = 1;
  } finally {
    try {
      browser.close();
    } catch (_) {}
    try {
      server.close();
    } catch (_) {}
    process.exit(process.exitCode || 0);
  }
})();
