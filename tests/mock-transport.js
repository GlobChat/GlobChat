/*
 * Test-only mock of the Supabase client used by GlobChat.
 * Injected BEFORE script.js on every page under test. Routes broadcast +
 * presence traffic between browser contexts through a BroadcastChannel hub,
 * so multi-client flows can be tested deterministically without network.
 *
 * Fidelity notes vs real supabase-js:
 * - broadcast.self honored (echo to sender only when configured).
 * - broadcast ack returns 'ok'.
 * - presence: track/untrack propagate; presenceState() shaped like
 *   { [key]: [meta, ...] }; sync events fired on membership changes.
 * - storage/table APIs are stubbed to fail loudly if accidentally used.
 */
(function () {
  if (window.__globchatMockInstalled) return;
  window.__globchatMockInstalled = true;

  const PAGE_ID =
    (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const HUB_NAME = "globchat-test-hub";
  const hub = new BroadcastChannel(HUB_NAME);

  /** channelName -> Map<event, Set<handler>> */
  const localChannels = new Map(); // name -> {handlers:Map, presenceKey, self, tracked, subscribed}
  /** channelName -> Map<presenceKey, meta> assembled from hub traffic */
  const presenceView = new Map();
  /** wire log of every outbound frame this page produced */
  window.__wireFrames = [];

  function publish(msg) {
    hub.postMessage({ ...msg, __from: PAGE_ID });
  }

  function emitLocal(name, event, payload) {
    const ch = localChannels.get(name);
    if (!ch || !ch.subscribed) return;
    const set = ch.handlers.get(event);
    if (!set) return;
    set.forEach((handler) => {
      try {
        handler({ payload });
      } catch (error) {
        console.error("[mock] handler error", error);
      }
    });
  }

  function rebuildPresence(name) {
    // Merge hub-known peers + this page's own tracking for the channel.
    const remote = presenceView.get(name) || new Map();
    const merged = new Map(remote);

    const ch = localChannels.get(name);
    if (ch && ch.tracked) {
      const key = ch.presenceKey;
      const existing = merged.get(key);
      const arr = Array.isArray(existing) ? existing.slice() : [];
      const filtered = arr.filter((m) => m && m.client_id !== ch.tracked.client_id);
      filtered.push(ch.tracked);
      merged.set(key, filtered);
    }
    return merged;
  }

  function fireSync(name) {
    const ch = localChannels.get(name);
    if (!ch) return;
    ch.presenceSnapshot = rebuildPresence(name);
    const set = ch.handlers.get("__sync");
    if (set) set.forEach((h) => h());
  }

  hub.onmessage = ({ data }) => {
    const msg = data;
    if (!msg || msg.__from === PAGE_ID) return;

    if (msg.kind === "broadcast") {
      // Deliver even to pages whose channel exists; subscription flag guards.
      emitLocal(msg.channel, msg.event, msg.payload);
      return;
    }

    if (msg.kind === "presence") {
      let m = presenceView.get(msg.channel);
      if (!m) {
        m = new Map();
        presenceView.set(msg.channel, m);
      }
      if (msg.state === null) {
        m.delete(msg.key);
      } else {
        m.set(msg.key, [msg.state]);
      }
      if (localChannels.has(msg.channel)) fireSync(msg.channel);
      return;
    }
  };

  function makeChannel(name, opts = {}) {
    const config = opts.config || {};
    const ch = {
      __name: name,
      self: Boolean(config.broadcast?.self),
      ack: Boolean(config.broadcast?.ack),
      presenceKey: config.presence?.key || PAGE_ID,
      handlers: new Map(),
      tracked: null,
      subscribed: false,
      presenceSnapshot: new Map()
    };

    localChannels.set(name, ch);

    const api = {
      __name: name,
      on(type, filter, handler) {
        if (type === "broadcast") {
          const event = filter?.event;
          if (!ch.handlers.has(event)) ch.handlers.set(event, new Set());
          ch.handlers.get(event).add(handler);
        } else if (type === "presence") {
          // All three presence events collapse into synthetic "__sync".
          if (!ch.handlers.has("__sync")) ch.handlers.set("__sync", new Set());
          ch.handlers.get("__sync").add(handler);
        }
        return api;
      },

      send(message) {
        if (message?.type !== "broadcast") {
          return Promise.resolve({ status: "error", message: "unsupported" });
        }
        const frame = {
          channel: name,
          event: message.event,
          payload: message.payload
        };
        window.__wireFrames.push(frame);
        publish({ kind: "broadcast", ...frame });

        if (ch.subscribed && ch.self) {
          // Async echo like the real thing.
          setTimeout(() => emitLocal(name, message.event, message.payload), 0);
        }
        return ch.ack ? Promise.resolve("ok") : Promise.resolve("ok");
      },

      track(state) {
        ch.tracked = { ...state };
        publish({
          kind: "presence",
          channel: name,
          key: ch.presenceKey,
          state: ch.tracked
        });
        fireSync(name);
        return Promise.resolve("ok");
      },

      untrack() {
        ch.tracked = null;
        publish({ kind: "presence", channel: name, key: ch.presenceKey, state: null });
        fireSync(name);
        return Promise.resolve("ok");
      },

      presenceState() {
        const snapshot = {};
        ch.presenceSnapshot.forEach((metas, key) => {
          snapshot[key] = metas;
        });
        // Include own tracking so counts behave like the real client.
        if (ch.tracked) {
          const arr = snapshot[ch.presenceKey] ? snapshot[ch.presenceKey].slice() : [];
          const cid = ch.tracked.client_id;
          if (!arr.some((m) => m && m.client_id === cid)) arr.push(ch.tracked);
          snapshot[ch.presenceKey] = arr;
        }
        return snapshot;
      },

      subscribe(statusCallback) {
        ch.subscribed = true;
        fireSync(name);
        setTimeout(() => statusCallback && statusCallback("SUBSCRIBED"), 0);
        return api;
      }
    };

    return api;
  }

  const mockClient = {
    createClient(_url, _key) {
      return {
        // Minimal surface for the app's connection watchdog.
        realtime: {
          isConnected: () => true
        },
        channel(name, opts) {
          return makeChannel(name, opts);
        },
        async removeChannel(chan) {
          const name = chan?.__name;
          const ch = localChannels.get(name);
          if (!ch) return "ok";
          if (ch.tracked) {
            ch.tracked = null;
            publish({ kind: "presence", channel: name, key: ch.presenceKey, state: null });
          }
          ch.subscribed = false;
          localChannels.delete(name);
          fireSync(name); // Let peers observe the departure.
          return "ok";
        },
        storage: {
          from() {
            throw new Error("[mock] storage unexpectedly used in tests");
          }
        },
        from() {
          throw new Error("[mock] database unexpectedly used in tests");
        }
      };
    }
  };

  // Non-writable: the real supabase-js UMD build assigns window.supabase
  // after us; in sloppy mode that assignment silently no-ops.
  Object.defineProperty(window, "supabase", {
    value: mockClient,
    writable: false,
    configurable: false
  });

  // Raw-frame injection for forgery/tamper tests.
  window.__mockRawSend = function (channelName, event, payload) {
    publish({ kind: "broadcast", channel: channelName, event, payload });
  };

  // Partition sessionStorage per frame: both app instances share the tab's
  // storage (same origin), but each must keep an independent session
  // snapshot — in production every user has their own tab.
  (function partitionSessionStorage() {
    const tag = window.frameElement && window.frameElement.id;
    if (!tag) return;
    const prefix = `gc-${tag}::`;
    const real = window.sessionStorage;
    const wrapped = {
      getItem: (k) => real.getItem(prefix + k),
      setItem: (k, v) => real.setItem(prefix + k, v),
      removeItem: (k) => real.removeItem(prefix + k),
      clear: () => {
        Array.from({ length: real.length })
          .map((_, i) => real.key(i))
          .filter((k) => k && k.startsWith(prefix))
          .forEach((k) => real.removeItem(k));
      },
      key: (i) => real.key(i),
      get length() {
        return real.length;
      }
    };
    Object.defineProperty(window, "sessionStorage", {
      value: wrapped,
      configurable: true
    });
  })();

  // Test introspection: channel inventory for this document.
  window.__mockDebug = function () {
    const out = [];
    localChannels.forEach((ch, name) => {
      out.push({
        name,
        subscribed: ch.subscribed,
        handlers: Array.from(ch.handlers.entries()).map(([e, set]) => `${e}:${set.size}`)
      });
    });
    return { pageId: PAGE_ID.slice(0, 8), channels: out, wire: window.__wireFrames.length };
  };
})();
