/* ============================================================
   GLOBAL CHAT
   Vanilla JS + Supabase Realtime Broadcast
   ------------------------------------------------------------
   IMPORTANT:
   - No users table.
   - No messages table.
   - No chat history is persisted by this application.
   - Names/messages live only in browser memory and broadcast payloads.
   ============================================================ */

// Supabase project URL and publishable/anon key live in config.js
// (window.GLOBCHAT_SUPABASE_*). They are public-by-design frontend values;
// the security boundary is RLS on the server, never key secrecy.
// See README.md → "Keys & security".
const SUPABASE_URL = window.GLOBCHAT_SUPABASE_URL;
const SUPABASE_KEY = window.GLOBCHAT_SUPABASE_KEY;

const CHANNEL_NAME = "global-chat";
const MESSAGE_EVENT = "chat-message";
const PRESENCE_KEY = "anonymous-client";

// Client-side limits. These are UX/anti-spam controls, not server security.
const MAX_NAME_LENGTH = 32;
// Not a user-facing cap — just a technical backstop so a single broadcast
// frame never grows large enough for Realtime to reject it.
const MAX_MESSAGE_LENGTH = 20000;
const MIN_SEND_INTERVAL_MS = 900;
// Files are uploaded to Supabase Storage (not inlined in the broadcast —
// Realtime frames can't carry anything this large); the message only
// broadcasts the resulting public URL. Requires the bucket + policies
// below to exist on the project — see the SQL at the bottom of this file.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ATTACHMENT_BUCKET = "chat-attachments";
const ATTACHMENT_BASE_URL = `${SUPABASE_URL}/storage/v1/object/public/${ATTACHMENT_BUCKET}/`;

/*
 * Private chat rooms (code gated, end-to-end encrypted).
 * - A room is identified by a 4-character alphanumeric code; its channel name
 *   derived from the code.
 * - The AES-GCM-256 room key is derived from the code with PBKDF2
 *   (SHA-256, per-room random salt). Message plaintext never touches the
 *   wire — only {salt, ciphertext} frames do.
 * - No persistence: rooms, keys and history live only in browser memory.
 */
const PRIVATE_CHANNEL_PREFIX = "private-chat:room-";
const PRIVATE_MESSAGE_EVENT = "private-message";
const ROOM_META_EVENT = "room-meta";
const ROOM_CODE_LENGTH = 4;
// Codes are number+letter mixes. Generation avoids ambiguous glyphs
// (0/O, 1/I/L); validation accepts any 4-char alphanumeric so legacy
// numeric rooms keep working.
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4}$/;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_EMPTY_EXPIRY_MS = 10 * 60 * 1000; // auto-close 10 min after empty
const ROOM_EXPIRY_CHECK_INTERVAL_MS = 30000;
// There is no server-side room registry — a room only "exists" for as long
// as someone else's channel is subscribed to that code. This is how long a
// join attempt waits for presence to reveal another occupant before it's
// treated as a wrong/unused code.
const ROOM_JOIN_TIMEOUT_MS = 6000;
const PBKDF2_ITERATIONS = 150000;
const SALT_BYTES = 16;
const MAX_PRIVATE_ROOMS = 8;
const PRIVATE_RECENT_IDS_CAP = 250;

/*
 * Session persistence (soft-reload survival).
 * State lives in sessionStorage: it survives F5/reload but is destroyed by
 * the browser the moment the tab or the whole browser closes — exactly the
 * required lifetime. A cache probe (cache-probe.txt) distinguishes a soft
 * reload (served from HTTP cache) from a hard refresh (cache bypassed, full
 * body re-downloaded): hard refresh wipes the saved state before restore.
 */
const SESSION_STORAGE_KEY = "globchat.session.v1";
const CACHE_PROBE_URL = "cache-probe.txt";
const SESSION_SAVE_DEBOUNCE_MS = 250;

/*
 * Realtime resilience tuning for restrictive networks (FortiGate DPI, hotel/
 * office WiFi, NAT gateways). Defaults assume pristine networks: a 30s
 * heartbeat means a killed connection takes up to ~30s to notice, and
 * backoff can stretch to 10-30s — the classic "connects after a 20-30s
 * loop". We detect death ~3x faster and retry aggressively.
 */
const REALTIME_HEARTBEAT_MS = 10000;
const REALTIME_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_CAP_MS = 5000;
const RECONNECT_DELAY_MS = 1500;
const WATCHDOG_INTERVAL_MS = 5000;
const PERSISTED_GLOBAL_CAP = 250;
const PERSISTED_ROOM_ROWS_CAP = 200;

let supabaseClient = null;
let chatChannel = null;
let currentName = "";
let clientId = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let lastSentAt = 0;
let reconnectTimer = null;
let isSubscribed = false;
let recentMessageIds = new Set();
let reportedMessageIds = new Set();
let pendingFile = null;
let isUploadingFile = false;
let privatePendingFile = null;
let isUploadingPrivateFile = false;

/* Private room state — all of it dies with the page. */
const privateRooms = new Map(); // code -> room
let activeRoomCode = null;
let currentMode = "global";

/* Soft-reload persistence state. */
let sessionSaveTimer = null;
let globalTranscript = []; // mirrors rendered global messages for persistence
const messageRecords = new Map();
const deletedForSelf = new Set();
let editingMessageId = null;
let editingPrivateMessage = null;
let messageContextMenu = null;

/* ----------------------------- DOM ----------------------------- */

const welcomeScreen = document.getElementById("welcome-screen");
const chatScreen = document.getElementById("chat-screen");
const nameForm = document.getElementById("name-form");
const nameInput = document.getElementById("name-input");
const nameError = document.getElementById("name-error");
const startButton = document.getElementById("start-button");

const messageList = document.getElementById("message-list");
const emptyState = document.getElementById("empty-state");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const currentUserName = document.getElementById("current-user-name");
const userAvatar = document.getElementById("user-avatar");

const connectionPill = document.getElementById("connection-pill");
const connectionText = document.getElementById("connection-text");
const onlineCount = document.getElementById("online-count");
const leaveButton = document.getElementById("leave-button");
const toastContainer = document.getElementById("toast-container");
const homeLogo = document.getElementById("home-logo");
const globalChatTab = document.getElementById("global-chat-tab");
const privateChatTab = document.getElementById("private-chat-tab");
const globalChatPanel = document.getElementById("global-chat-panel");
const privateChatPanel = document.getElementById("private-chat-panel");

const privateUnreadBadge = document.getElementById("private-unread-badge");
const conversationList = document.getElementById("conversation-list");
const conversationListEmpty = document.getElementById("conversation-list-empty");
const newRoomButton = document.getElementById("new-room-button");
const privateLayout = document.getElementById("private-layout");
const createRoomButton = document.getElementById("create-room-button");
const roomNameInput = document.getElementById("room-name-input");
const joinRoomForm = document.getElementById("join-room-form");
const roomCodeInput = document.getElementById("room-code-input");
const joinRoomButton = document.getElementById("join-room-button");
const joinRoomError = document.getElementById("join-room-error");
const privateThreadEmpty = document.getElementById("private-thread-empty");
const privateThreadActive = document.getElementById("private-thread-active");
const privateThreadSection = document.getElementById("private-thread");
const privateBackButton = document.getElementById("private-back-button");
const privateStartBack = document.getElementById("private-start-back");
const roomAvatar = document.getElementById("room-avatar");
const roomTitle = document.getElementById("room-title");
const roomStatus = document.getElementById("room-status");
const roomStatusText = document.getElementById("room-status-text");
const copyCodeButton = document.getElementById("copy-code-button");
const roomMembersButton = document.getElementById("room-members-button");
const roomMembersCount = document.getElementById("room-members-count");
const roomMembersPanel = document.getElementById("room-members-panel");
const roomMembersList = document.getElementById("room-members-list");
const roomCodeLabel = document.getElementById("room-code-label");
const privateCloseButton = document.getElementById("private-close-button");
const privateMessageList = document.getElementById("private-message-list");
const privateEmptyState = document.getElementById("private-empty-state");
const privateMessageForm = document.getElementById("private-message-form");
const privateMessageInput = document.getElementById("private-message-input");
const privateSendButton = document.getElementById("private-send-button");
const privateAttachButton = document.getElementById("private-attach-button");
const privateFileInput = document.getElementById("private-file-input");
const editingBanner = document.getElementById("editing-banner");
const cancelEditButton = document.getElementById("cancel-edit-button");
const privateAttachmentPreview = document.getElementById("private-attachment-preview");
const privateAttachmentName = document.getElementById("private-attachment-name");
const privateAttachmentSize = document.getElementById("private-attachment-size");
const privateRemoveAttachmentButton = document.getElementById("private-remove-attachment");

const attachButton = document.getElementById("attach-button");
const fileInput = document.getElementById("file-input");
const attachmentPreview = document.getElementById("attachment-preview");
const attachmentName = document.getElementById("attachment-name");
const attachmentSize = document.getElementById("attachment-size");
const removeAttachmentButton = document.getElementById("remove-attachment");

/* ------------------------- Configuration ------------------------ */

function hasValidConfig() {
  return (
    SUPABASE_URL &&
    SUPABASE_KEY &&
    !SUPABASE_URL.includes("YOUR_") &&
    !SUPABASE_KEY.includes("YOUR_")
  );
}

function initializeSupabase() {
  if (!hasValidConfig()) {
    showToast("Add your Supabase URL and publishable/anon key in script.js.");
    return false;
  }

  if (!window.supabase?.createClient) {
    showToast("Chat failed to load. Please refresh and try again.");
    return false;
  }

  try {
    // The frontend must ONLY use a publishable/anon key.
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      realtime: {
        // Notice dead sockets in ~10s instead of ~30s (FortiGate DPI and
        // NAT gateways silently drop idle/long-lived WebSocket sessions).
        heartbeatIntervalMs: REALTIME_HEARTBEAT_MS,
        timeout: REALTIME_TIMEOUT_MS,
        // Cap reconnect backoff so a flaky network recovers in seconds.
        reconnectAfterMs: (tries) =>
          Math.min(500 * Math.pow(1.7, Math.max(tries - 1, 0)), RECONNECT_DELAY_CAP_MS)
      }
    });
  } catch (error) {
    console.error("Supabase setup failed:", error);
    showToast("Chat could not be initialized. Please try again later.");
    return false;
  }
  return true;
}

/* ---------------------- Input validation ------------------------ */

function cleanText(value, maxLength) {
  // Normalize whitespace but preserve newlines in messages.
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanMessage(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function validateName(rawName) {
  const name = cleanText(rawName, MAX_NAME_LENGTH);

  if (!name) return { valid: false, message: "Please enter your name." };
  if (name.length < 1) return { valid: false, message: "Name is too short." };
  if (name.length > MAX_NAME_LENGTH) {
    return { valid: false, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }

  // Reject control characters. Text is rendered with textContent, never innerHTML.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(name)) {
    return { valid: false, message: "Please use normal text characters only." };
  }

  return { valid: true, value: name };
}

function validateMessage(rawMessage, hasAttachment = false) {
  const message = cleanMessage(rawMessage);

  if (!message && !hasAttachment) {
    return { valid: false, message: "Message cannot be empty." };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, message: "That message is too long to send." };
  }

  if (/[\u0000]/.test(message)) {
    return { valid: false, message: "That message contains an invalid character." };
  }

  return { valid: true, value: message };
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* --------------------- Private rooms: crypto --------------------- */

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function generateRoomCode() {
  const random = new Uint32Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(random);
  return Array.from(random)
    .map((value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length])
    .join("");
}

function privateChannelName(code) {
  return `${PRIVATE_CHANNEL_PREFIX}${code}`;
}

/*
 * Derives the room key from the room code. The salt is random per room
 * and travels in plaintext on the channel — it is what forces an attacker
 * to redo the full PBKDF2 work per room instead of precomputing tables.
 */
async function deriveRoomKey(code, saltB64) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`globchat-room:${code}`),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(saltB64),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPrivatePayload(key, plainObject) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(plainObject));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  const frame = new Uint8Array(iv.length + ciphertext.byteLength);
  frame.set(iv, 0);
  frame.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(frame);
}

async function decryptPrivatePayload(key, frameB64) {
  const frame = base64ToBytes(frameB64);
  if (frame.length <= 12) throw new Error("Ciphertext frame too short");

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: frame.slice(0, 12) },
    key,
    frame.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/*
 * Binary counterparts of encryptPrivatePayload/decryptPrivatePayload, used
 * for file attachments in private rooms. Files never travel through the
 * Realtime channel (too large for a broadcast frame) — they're encrypted
 * client-side and the ciphertext bytes are what actually land in Storage,
 * so the file content is never visible to the storage provider, only its
 * (still-public) URL, and that URL is itself only ever revealed inside an
 * AES-GCM-encrypted message envelope.
 */
async function encryptFileBytes(key, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, arrayBuffer);

  const frame = new Uint8Array(iv.length + ciphertext.byteLength);
  frame.set(iv, 0);
  frame.set(new Uint8Array(ciphertext), iv.length);
  return frame;
}

async function decryptFileBytes(key, arrayBuffer) {
  const frame = new Uint8Array(arrayBuffer);
  if (frame.length <= 12) throw new Error("Encrypted file frame too short");

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: frame.slice(0, 12) },
    key,
    frame.slice(12)
  );
}

/* ------------------ Session persistence (soft reload) ------------------ */

/*
 * State lifetime contract:
 *   - F5 / soft reload  → restored (name, rooms, transcripts, unread).
 *   - Hard refresh      → cache bypassed, probe detects it, state wiped.
 *   - Tab/browser close → sessionStorage is destroyed by the browser.
 */
function scheduleSessionSave() {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    saveSession();
  }, SESSION_SAVE_DEBOUNCE_MS);
}

function saveSession() {
  if (!currentName) return;

  try {
    const snapshot = {
      v: 1,
      name: currentName,
      clientId,
      mode: currentMode,
      activeRoomCode,
      global: globalTranscript.slice(-PERSISTED_GLOBAL_CAP),
      reportedIds: Array.from(reportedMessageIds),
      rooms: Array.from(privateRooms.values()).map((room) => ({
        code: room.code,
        saltB64: room.saltB64,
        name: room.name || "",
        unread: room.unread,
        preview: room.preview,
        lastActivityAt: room.lastActivityAt,
        transcript: (room.transcript || []).slice(-PERSISTED_ROOM_ROWS_CAP)
      }))
    };
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (_) {
    // Quota/private-mode failures must never break the chat.
  }
}

function loadSavedSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || saved.v !== 1 || typeof saved.name !== "string" || !saved.name) return null;
    return saved;
  } catch (_) {
    return null;
  }
}

function clearSavedSession() {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (_) {}
}

/*
 * Soft-vs-hard reload classification via the NavigationTiming entry:
 *   - Soft reload: the main document is revalidated (Cache-Control: no-cache)
 *     and Chrome reports the 304's wire size — transferSize (headers only)
 *     is far SMALLER than the document body sizes.
 *   - Hard refresh: the cache is bypassed and the full document travels the
 *     wire — transferSize >= encodedBodySize.
 * Requires the host to serve index.html with no-cache/must-revalidate (see
 * README → hosting notes). On hosts that cache the document, an ambiguous
 * full-body entry is treated as a hard refresh (safe default: fresh start).
 */
function isSoftReload() {
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (!nav || nav.type !== "reload") return false;
    return nav.transferSize > 0 && nav.transferSize < nav.encodedBodySize;
  } catch (_) {
    return false;
  }
}

async function restoreSession(saved) {
  if (!initializeSupabase()) {
    clearSavedSession();
    return false;
  }

  currentName = saved.name;
  if (typeof saved.clientId === "string" && saved.clientId) {
    clientId = saved.clientId; // Keep presence keys and message ids stable.
  }

  // Header + screens: skip the welcome flow entirely.
  currentUserName.textContent = currentName;
  userAvatar.textContent = getInitial(currentName);
  welcomeScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");

  // Global transcript.
  if (Array.isArray(saved.global)) {
    for (const data of saved.global) {
      renderMessage({ payload: data });
    }
  }
  if (Array.isArray(saved.reportedIds)) {
    saved.reportedIds.forEach((id) => reportedMessageIds.add(String(id)));
  }

  // Rooms: rebuild shells, re-derive keys from code+salt, resubscribe.
  if (Array.isArray(saved.rooms)) {
    for (const savedRoom of saved.rooms) {
      if (!isValidRoomCode(savedRoom.code)) continue;
      if (privateRooms.size >= MAX_PRIVATE_ROOMS) break;

      const room = createRoomShell(savedRoom.code, savedRoom.saltB64 || null);
      room.name = cleanText(savedRoom.name, MAX_NAME_LENGTH);
      room.unread = Number(savedRoom.unread) || 0;
      room.preview = typeof savedRoom.preview === "string" ? savedRoom.preview : "";
      room.lastActivityAt = typeof savedRoom.lastActivityAt === "string" ? savedRoom.lastActivityAt : "";

      if (Array.isArray(savedRoom.transcript)) {
        room.transcript = savedRoom.transcript
          .filter((row) => row && typeof row.m === "string")
          .slice(-PERSISTED_ROOM_ROWS_CAP);
        // Stored as data — openRoom() builds the actual DOM from this
        // on demand, once the room object (and its key) is ready.
        for (const row of room.transcript) {
          if (row.sys) {
            room.listRows.push({ type: "system", text: cleanText(row.m, 200) });
            continue;
          }
          room.listRows.push({
            type: "message",
            senderName: cleanText(row.n, MAX_NAME_LENGTH) || "anonymous",
            messageText: cleanMessage(row.m),
            sentAtRaw: row.t,
            isOwnMessage: Boolean(row.own),
            attachmentData: row.f && isRenderableAttachment(row.f) ? row.f : null,
            id: row.id, clientId: row.c, name: cleanText(row.n, MAX_NAME_LENGTH) || "anonymous",
            message: cleanMessage(row.m), sentAt: row.t, reactions: row.reactions || {}, edited: Boolean(row.edited), deleted: Boolean(row.deleted)
          });
        }
      }

      privateRooms.set(room.code, room);

      try {
        if (room.saltB64) {
          room.key = await deriveRoomKey(room.code, room.saltB64);
        }
      } catch (error) {
        console.error("Room key re-derivation failed:", error);
      }

      subscribeRoomChannel(room);
    }
  }

  activeRoomCode = null;
  const targetMode = saved.mode === "private" ? "private" : "global";
  setChatMode(targetMode);

  if (targetMode === "private") {
    const active =
      (saved.activeRoomCode && privateRooms.get(saved.activeRoomCode)) ||
      Array.from(privateRooms.values())[0];
    if (active) {
      openRoom(active.code);
    } else {
      setThreadVisible(false);
    }
  } else {
    setThreadVisible(false);
  }

  renderRoomsDirectory();
  updateUnreadBadge();
  await subscribeToChat();
  scheduleSessionSave();
  return true;
}

/* ------------------------- UI helpers --------------------------- */

function setConnectionState(state, label) {
  connectionPill.dataset.state = state;
  connectionText.textContent = label;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4200);
}

function setNameError(message = "") {
  nameError.textContent = message;
}

function getInitial(name) {
  return (name.trim()[0] || "?").toUpperCase();
}

function autoResizeTextarea() {
  // No fixed cap here — CSS max-height on the textarea is the real limit,
  // this just grows it to fit content up to that point.
  messageInput.style.height = "auto";
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

function scrollToBottom(targetList = messageList) {
  targetList.scrollTop = targetList.scrollHeight;
}

function isNearBottom(targetList) {
  return targetList.scrollHeight - targetList.scrollTop - targetList.clientHeight < 90;
}

function setChatMode(mode) {
  const isGlobal = mode === "global";
  currentMode = mode;

  globalChatTab.classList.toggle("is-active", isGlobal);
  privateChatTab.classList.toggle("is-active", !isGlobal);
  globalChatTab.setAttribute("aria-selected", String(isGlobal));
  privateChatTab.setAttribute("aria-selected", String(!isGlobal));

  globalChatPanel.classList.toggle("hidden", !isGlobal);
  privateChatPanel.classList.toggle("hidden", isGlobal);
  globalChatPanel.setAttribute("aria-hidden", String(!isGlobal));
  privateChatPanel.setAttribute("aria-hidden", String(isGlobal));
}

/* --------------------- Notification sound ------------------------ */

/*
 * Short two-tone chime synthesized with WebAudio — no asset files, works
 * offline. Autoplay policies require a user gesture first, so the context
 * is created/resumed on the earliest interaction.
 */
let audioCtx = null;
let lastSoundAt = 0;

function ensureAudioContext() {
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch (_) {
    return null;
  }
}

function playNotificationSound() {
  const ctx = ensureAudioContext();
  if (!ctx || ctx.state !== "running") return;

  const now = Date.now();
  if (now - lastSoundAt < 600) return; // Throttle overlapping dings.
  lastSoundAt = now;

  const t0 = ctx.currentTime;
  [
    [880.0, 0.0],    // A5
    [1174.66, 0.09]  // D6
  ].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + delay);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0 + delay);
    osc.stop(t0 + delay + 0.4);
  });
}

// Unlock audio on the earliest user gesture (autoplay policy).
["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
  document.addEventListener(eventName, () => ensureAudioContext(), {
    passive: true
  });
});

/* ------------------------ File attachments ------------------------ */

function resetAttachmentState() {
  pendingFile = null;
  fileInput.value = "";
  attachmentPreview.classList.add("hidden");
  attachmentName.textContent = "";
  attachmentSize.textContent = "";
}

// Deletes the uploaded object (if any) and resets the composer. Use this for
// an explicit cancel/leave — NOT after a successful send, since the file is
// still referenced by the message that was just broadcast.
function clearAttachment() {
  if (pendingFile?.path && supabaseClient) {
    supabaseClient.storage.from(ATTACHMENT_BUCKET).remove([pendingFile.path]).catch(() => {});
  }
  resetAttachmentState();
}

/*
 * Uploads one file to Supabase Storage and returns the attachment record
 * {name,type,size,url,path} — or null on failure (toast already shown).
 */
async function uploadAttachment(file) {
  if (!file) return null;

  if (file.size > MAX_FILE_SIZE) {
    showToast(`That file is too big (${formatFileSize(MAX_FILE_SIZE)} max).`);
    return null;
  }

  if (!supabaseClient) {
    showToast("Not connected yet — try again in a moment.");
    return null;
  }

  const displayName = cleanText(file.name, 200) || "file";
  const safeName = displayName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${clientId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

  const { error: uploadError } = await supabaseClient.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabaseClient.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);

  return {
    name: displayName,
    type: file.type || "application/octet-stream",
    size: file.size,
    url: publicUrlData.publicUrl,
    path
  };
}

async function handleFileSelection(file) {
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    showToast(`That file is too big (${formatFileSize(MAX_FILE_SIZE)} max).`);
    fileInput.value = "";
    return;
  }

  if (!supabaseClient) {
    showToast("Not connected yet — try again in a moment.");
    fileInput.value = "";
    return;
  }

  const displayName = cleanText(file.name, 200) || "file";

  isUploadingFile = true;
  attachButton.disabled = true;
  removeAttachmentButton.disabled = true;
  attachmentName.textContent = displayName;
  attachmentSize.textContent = "Uploading…";
  attachmentPreview.classList.remove("hidden");

  try {
    pendingFile = await uploadAttachment(file);
    if (!pendingFile) throw new Error("upload failed");
    attachmentSize.textContent = formatFileSize(file.size);
    messageInput.focus();
  } catch (error) {
    console.error("File upload failed:", error);
    showToast(
      "Could not upload that file — the storage bucket may not be set up yet on this project."
    );
    clearAttachment();
  } finally {
    isUploadingFile = false;
    attachButton.disabled = false;
    removeAttachmentButton.disabled = false;
  }
}

/* -------- Private composer attachments (encrypted envelope) -------- */

function resetPrivateAttachmentState() {
  privatePendingFile = null;
  privateFileInput.value = "";
  privateAttachmentPreview.classList.add("hidden");
  privateAttachmentName.textContent = "";
  privateAttachmentSize.textContent = "";
}

function clearPrivateAttachment() {
  if (privatePendingFile?.path && supabaseClient) {
    supabaseClient.storage.from(ATTACHMENT_BUCKET).remove([privatePendingFile.path]).catch(() => {});
  }
  resetPrivateAttachmentState();
}

/*
 * Encrypts the file with the room key BEFORE it ever leaves the browser,
 * then uploads the ciphertext. Storage only ever sees opaque bytes — this
 * is what makes "end-to-end encrypted" true for attachments too, not just
 * message text. Requires the room key to already be derived (see
 * ensureRoomKey / handleRoomMeta) since there is nothing to encrypt with
 * otherwise.
 */
async function uploadPrivateAttachment(file, room) {
  if (!file) return null;

  if (file.size > MAX_FILE_SIZE) {
    showToast(`That file is too big (${formatFileSize(MAX_FILE_SIZE)} max).`);
    return null;
  }

  if (!supabaseClient) {
    showToast("Not connected yet — try again in a moment.");
    return null;
  }

  if (!room?.key) {
    showToast("This room isn't ready to encrypt files yet — try again in a moment.");
    return null;
  }

  const displayName = cleanText(file.name, 200) || "file";
  const safeName = displayName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${clientId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}.enc`;

  const rawBytes = await file.arrayBuffer();
  const encryptedBytes = await encryptFileBytes(room.key, rawBytes);

  const { error: uploadError } = await supabaseClient.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, encryptedBytes, { contentType: "application/octet-stream", upsert: false });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabaseClient.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);

  return {
    name: displayName,
    type: file.type || "application/octet-stream",
    size: file.size,
    url: publicUrlData.publicUrl,
    path
  };
}

async function handlePrivateFileSelection(file) {
  if (!file) return;

  const room = privateRooms.get(activeRoomCode);
  if (!room) return;

  if (file.size > MAX_FILE_SIZE) {
    showToast(`That file is too big (${formatFileSize(MAX_FILE_SIZE)} max).`);
    privateFileInput.value = "";
    return;
  }

  if (!supabaseClient) {
    showToast("Not connected yet — try again in a moment.");
    privateFileInput.value = "";
    return;
  }

  if (!room.key) {
    showToast("This room isn't ready to encrypt files yet — try again in a moment.");
    privateFileInput.value = "";
    return;
  }

  const displayName = cleanText(file.name, 200) || "file";

  isUploadingPrivateFile = true;
  privateAttachButton.disabled = true;
  privateRemoveAttachmentButton.disabled = true;
  privateAttachmentName.textContent = displayName;
  privateAttachmentSize.textContent = "Encrypting…";
  privateAttachmentPreview.classList.remove("hidden");

  try {
    privatePendingFile = await uploadPrivateAttachment(file, room);
    if (!privatePendingFile) throw new Error("upload failed");
    privateAttachmentSize.textContent = formatFileSize(file.size);
    privateMessageInput.focus();
  } catch (error) {
    console.error("Private file upload failed:", error);
    showToast("Could not upload that file — the storage bucket may not be set up yet.");
    clearPrivateAttachment();
  } finally {
    isUploadingPrivateFile = false;
    privateAttachButton.disabled = false;
    privateRemoveAttachmentButton.disabled = false;
  }
}

/* --------------------- Attachment action menu --------------------- */

let attachmentMenuEl = null;

function closeAttachmentMenu() {
  if (attachmentMenuEl) {
    attachmentMenuEl.remove();
    attachmentMenuEl = null;
  }
  document.removeEventListener("pointerdown", onMenuOutsidePointer, true);
  document.removeEventListener("keydown", onMenuKeydown, true);
  window.removeEventListener("resize", closeAttachmentMenu);
  window.removeEventListener("scroll", closeAttachmentMenu, true);
}

function onMenuOutsidePointer(event) {
  if (attachmentMenuEl && !attachmentMenuEl.contains(event.target)) {
    closeAttachmentMenu();
  }
}

function onMenuKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeAttachmentMenu();
  }
}

// Fetches the stored bytes and, for a room attachment, decrypts them with
// the room key — the ciphertext on the wire/at rest is never handed to the
// browser as-is for a private room.
async function fetchAttachmentBlob(data, room) {
  const response = await fetch(data.fileUrl, { cache: "default" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  if (!room) return response.blob();

  if (!room.key) throw new Error("Room key not available");
  const encryptedBytes = await response.arrayBuffer();
  const plainBytes = await decryptFileBytes(room.key, encryptedBytes);
  return new Blob([plainBytes], { type: data.fileType || "application/octet-stream" });
}

async function downloadAttachment(data, room) {
  // Fetch → blob → object URL so the browser saves the file with its
  // original name instead of navigating to the storage URL.
  showToast(room ? "Decrypting…" : "Downloading…");
  try {
    const blob = await fetchAttachmentBlob(data, room);
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = data.fileName || "file";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  } catch (error) {
    console.error("Download failed:", error);
    if (room) {
      showToast("Download failed — could not decrypt that file.");
    } else {
      showToast("Download failed — opening in a new tab instead.");
      window.open(data.fileUrl, "_blank", "noopener");
    }
  }
}

async function openAttachmentInNewTab(data, room) {
  if (!room) {
    window.open(data.fileUrl, "_blank", "noopener");
    return;
  }
  showToast("Decrypting…");
  try {
    const blob = await fetchAttachmentBlob(data, room);
    const objectUrl = URL.createObjectURL(blob);
    window.open(objectUrl, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (error) {
    console.error("Open failed:", error);
    showToast("Could not decrypt that file.");
  }
}

function openAttachmentMenu(anchorEl, data, room) {
  closeAttachmentMenu();

  const menu = document.createElement("div");
  menu.className = "attachment-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Attachment: ${data.fileName}`);

  // Private-room attachments are encrypted at rest — the raw storage link
  // is useless without the room key, so there's nothing sensible to copy.
  const items = room
    ? [
        { label: "⬇ Download", action: () => downloadAttachment(data, room) },
        { label: "↗ Open in new tab", action: () => openAttachmentInNewTab(data, room) }
      ]
    : [
        { label: "⬇ Download", action: () => downloadAttachment(data) },
        { label: "↗ Open in new tab", action: () => openAttachmentInNewTab(data) },
        {
          label: "⧉ Copy link",
          action: async () => {
            try {
              if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(data.fileUrl);
              } else {
                const helper = document.createElement("textarea");
                helper.value = data.fileUrl;
                document.body.appendChild(helper);
                helper.select();
                document.execCommand("copy");
                helper.remove();
              }
              showToast("Link copied.");
            } catch (_) {
              showToast("Could not copy the link.");
            }
          }
        }
      ];

  items.forEach(({ label, action }) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "attachment-menu-item";
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", () => {
      closeAttachmentMenu();
      action();
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  attachmentMenuEl = menu;

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  if (left + menuRect.width > window.scrollX + window.innerWidth - 12) {
    left = window.scrollX + window.innerWidth - 12 - menuRect.width;
  }
  if (top + menuRect.height > window.scrollY + window.innerHeight - 12) {
    top = rect.top + window.scrollY - menuRect.height - 6;
  }
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(12, left)}px`;

  setTimeout(() => {
    document.addEventListener("pointerdown", onMenuOutsidePointer, true);
    document.addEventListener("keydown", onMenuKeydown, true);
    window.addEventListener("resize", closeAttachmentMenu);
    window.addEventListener("scroll", closeAttachmentMenu, true);
  }, 0);
}

function isRenderableAttachment(data) {
  return (
    typeof data.fileUrl === "string" &&
    data.fileUrl.startsWith(ATTACHMENT_BASE_URL) &&
    typeof data.fileName === "string" &&
    data.fileName.trim().length > 0
  );
}

function buildAttachmentElement(data, room) {
  const fileName = cleanText(data.fileName, 200) || "file";
  // Room attachments are encrypted at rest — the raw URL is ciphertext, so
  // it can't be used as an <img src> directly. Those render as a plain
  // file chip; use the menu's "Open in new tab" to decrypt and view it.
  const isPreviewableImage =
    !room &&
    typeof data.fileType === "string" &&
    data.fileType.startsWith("image/") &&
    data.fileType !== "image/svg+xml";

  const openMenu = (event) => {
    event.preventDefault();
    openAttachmentMenu(event.currentTarget, data, room);
  };

  if (isPreviewableImage) {
    const link = document.createElement("a");
    link.href = data.fileUrl;
    link.className = "message-file-image-link attachment-trigger";

    const img = document.createElement("img");
    img.src = data.fileUrl;
    img.alt = fileName;
    img.className = "message-file-image";
    img.loading = "lazy";

    link.appendChild(img);
    link.addEventListener("click", openMenu);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMenu(event);
      }
    });
    return link;
  }

  // Encrypted room attachments use a <button>, not an <a href>: the raw
  // storage URL is ciphertext, and a native "open link in new tab" would
  // bypass our decrypt step and show garbage bytes.
  const link = document.createElement(room ? "button" : "a");
  if (room) {
    link.type = "button";
  } else {
    link.href = data.fileUrl;
  }
  link.className = "message-file-link attachment-trigger";

  const icon = document.createElement("span");
  icon.className = "message-file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>';

  const label = document.createElement("span");
  label.className = "message-file-name";
  label.textContent = fileName;

  link.append(icon, label);
  link.addEventListener("click", openMenu);
  link.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(event);
    }
  });
  return link;
}

/* ---------------------- Message rendering ----------------------- */

/*
 * Security rule:
 * Never insert user-controlled values with innerHTML.
 * We create elements and assign user content through textContent.
 */
function rememberMessage(id) {
  if (!id) return true;
  if (recentMessageIds.has(id)) return false;

  recentMessageIds.add(id);
  if (recentMessageIds.size > 250) {
    recentMessageIds.delete(recentMessageIds.values().next().value);
  }
  return true;
}

// Writes a copy of one flagged message (not a log of every message) to a
// write-only table — the app itself has no read access to it. See
// supabase-reports-setup.sql.
async function reportMessage(data, senderName, messageText, button) {
  if (!data?.id || reportedMessageIds.has(data.id)) return;

  if (!supabaseClient) {
    showToast("Not connected yet — try again in a moment.");
    return;
  }

  reportedMessageIds.add(data.id);
  button.disabled = true;
  button.dataset.reported = "true";
  button.title = "Reported";
  button.setAttribute("aria-label", "Message reported");

  try {
    const { error } = await supabaseClient.from("message_reports").insert({
      message_id: String(data.id).slice(0, 200),
      sender_name: senderName,
      sender_client_id: typeof data.clientId === "string" ? data.clientId.slice(0, 200) : "unknown",
      message_text: messageText || null,
      file_name: typeof data.fileName === "string" ? data.fileName.slice(0, 200) : null,
      file_url: isRenderableAttachment(data) ? data.fileUrl : null,
      reported_by_client_id: clientId
    });

    if (error) throw error;
    scheduleSessionSave();
    showToast("Message reported.");
  } catch (error) {
    console.error("Report failed:", error);
    showToast("Could not report that message — the reports table may not be set up yet.");
    reportedMessageIds.delete(data.id);
    button.disabled = false;
    button.dataset.reported = "false";
    button.title = "Report this message";
  }
}

function closeMessageContextMenu() {
  if (messageContextMenu) messageContextMenu.remove();
  messageContextMenu = null;
}

function sendMessageAction(action, data) {
  if (!chatChannel || !isSubscribed || !data?.id) return;
  chatChannel.send({ type: "broadcast", event: MESSAGE_EVENT, payload: {
    action, id: data.id, targetClientId: data.clientId, actorClientId: clientId,
    ...(action === "edit" ? { message: data.message, editedAt: data.editedAt } : {}),
    ...(action === "reaction" ? { emoji: data.emoji, remove: data.remove } : {})
  }}).catch((error) => console.error("Message action failed:", error));
}

function updateTranscriptRecord(data) {
  const index = globalTranscript.findIndex((item) => item.id === data.id);
  if (index >= 0) globalTranscript[index] = { ...globalTranscript[index], ...data };
  scheduleSessionSave();
}

function renderReactionSummary(bubble, data, onReact = toggleReaction) {
  const reactions = data.reactions || {};
  const entries = Object.entries(reactions).filter(([, value]) => value && value.count > 0);
  if (!entries.length) return;
  const wrap = document.createElement("div"); wrap.className = "message-reactions";
  entries.forEach(([emoji, value]) => {
    const pill = document.createElement("button"); pill.type = "button"; pill.className = "reaction-pill";
    if (value.users?.includes(clientId)) pill.classList.add("is-own");
    pill.textContent = `${emoji} ${value.count}`; pill.title = "Toggle reaction";
    pill.addEventListener("click", () => onReact(data, emoji)); wrap.appendChild(pill);
  });
  bubble.appendChild(wrap);
}

function toggleReaction(data, emoji) {
  const reactions = data.reactions || (data.reactions = {});
  const entry = reactions[emoji] || { count: 0, users: [] };
  const users = Array.isArray(entry.users) ? entry.users : [];
  const index = users.indexOf(clientId); const remove = index >= 0;
  if (remove) users.splice(index, 1); else users.push(clientId);
  entry.users = users; entry.count = users.length; reactions[emoji] = entry;
  updateTranscriptRecord(data);
  document.querySelector(`[data-message-id="${CSS.escape(String(data.id))}"]`)?.replaceWith(buildGlobalMessageRow(data));
  sendMessageAction("reaction", { ...data, emoji, remove });
}

function showReactionPicker(data, x, y) {
  closeMessageContextMenu();
  const picker = createQuickReactionPicker(data, x, y);
  document.body.appendChild(picker); messageContextMenu = picker;
  picker.style.left = `${Math.max(8, Math.min(x, innerWidth - picker.offsetWidth - 8))}px`;
  picker.style.top = `${Math.max(8, Math.min(y, innerHeight - picker.offsetHeight - 8))}px`;
}

function createQuickReactionPicker(data, x, y, onReact = toggleReaction) {
  const picker = document.createElement("div"); picker.className = "reaction-picker-menu quick-reaction-picker";
  ["👍", "❤️", "😂", "😮", "😢", "🙏"].forEach((emoji) => {
    const button = document.createElement("button"); button.className = "reaction-picker-item";
    button.type = "button"; button.textContent = emoji; button.title = emoji;
    button.addEventListener("click", () => { closeMessageContextMenu(); onReact(data, emoji); }); picker.appendChild(button);
  });
  return picker;
}

const reactionCategories = {
  "Smileys & People": "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫡 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🙏 💪 🧠 👀 👁️ 👄 💋 💅",
  Animals: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🪲 🦋 🐌 🐞 🐜 🕷️ 🦂 🐢 🐍 🦎 🦖 🐙 🦀 🐠 🐟 🐡 🐬 🐳 🦈 🐊 🐘 🦏 🦒 🦓 🦍 🐪 🐫 🐄 🐎 🐖 🐑 🐐 🦌 🐕 🐈",
  Food: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍞 🥐 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍔 🍟 🍕 🌭 🌮 🌯 🥗 🍿 🍣 🍤 🍜 🍝 🍦 🍩 🍪 🎂 🍰 🍫 🍬 🍭 ☕ 🍵 🧃 🥤 🍺 🍻 🍷 🍸 🍹",
  Activities: "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🪁 🏓 🏸 🥊 🥋 🛹 🛷 ⛸️ 🎿 🏆 🥇 🥈 🥉 🏅 🎖️ 🎮 🕹️ 🎲 ♟️ 🎯 🎳 🎭 🎨 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎬",
  Travel: "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🚲 ✈️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛳️ 🚢 ⚓ 🗺️ 🗽 🗼 🏰 🏯 🏝️ 🏖️ 🏕️ ⛺ 🏠 🏢 🌋 🗿",
  Objects: "⌚ 📱 💻 ⌨️ 🖨️ 🖱️ 💡 🔦 📷 📺 🎥 📞 🔋 🔌 💰 💎 🔑 🔒 🔓 🔨 🪓 🛠️ ⚔️ 🔫 🧨 🧸 🎁 🎈 ✉️ 📝 📌 📍 📎 📚 🔍 🛒 🧳 ☂️",
  Symbols: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ ⭐ 🌟 💫 🔥 💥 💯 ✅ ❌ ❗ ❓ ⚠️ 🚫 ♻️ ✔️ ☑️ ➕ ➖ ✖️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪",
  Flags: "🏁 🚩 🎌 🏳️ 🏴 🏳️‍🌈 🏴‍☠️ 🇺🇸 🇬🇧 🇮🇳 🇨🇦 🇦🇺 🇯🇵 🇰🇷 🇫🇷 🇩🇪 🇮🇹 🇪🇸 🇧🇷 🇲🇽 🇿🇦 🇸🇬 🇦🇪 🇳🇿 🇵🇭 🇹🇭 🇻🇳 🇨🇳"
};

function showFullReactionPicker(data, x, y, onReact = toggleReaction) {
  closeMessageContextMenu();
  const picker = document.createElement("div"); picker.className = "full-reaction-picker message-context-menu";
  const search = document.createElement("input"); search.className = "reaction-search"; search.type = "search"; search.placeholder = "Search reaction"; search.setAttribute("aria-label", "Search reaction"); picker.appendChild(search);
  const tabs = document.createElement("div"); tabs.className = "reaction-category-tabs"; picker.appendChild(tabs);
  const grid = document.createElement("div"); grid.className = "reaction-grid"; picker.appendChild(grid);
  let active = Object.keys(reactionCategories)[0];
  const render = () => {
    grid.textContent = ""; const query = search.value.trim().toLowerCase();
    const emojis = reactionCategories[active].split(" ").filter((emoji) => !query || emoji.includes(query));
    emojis.forEach((emoji) => { const button = document.createElement("button"); button.type = "button"; button.className = "reaction-grid-item"; button.textContent = emoji; button.title = emoji; button.addEventListener("click", () => { closeMessageContextMenu(); onReact(data, emoji); }); grid.appendChild(button); });
  };
  Object.keys(reactionCategories).forEach((category) => { const tab = document.createElement("button"); tab.type = "button"; tab.className = "reaction-category-tab"; tab.textContent = category.split(" ")[0]; tab.title = category; tab.addEventListener("click", () => { active = category; tabs.querySelectorAll("button").forEach((item) => item.classList.remove("is-active")); tab.classList.add("is-active"); render(); }); tabs.appendChild(tab); });
  tabs.firstChild.classList.add("is-active"); search.addEventListener("input", render); render();
  document.body.appendChild(picker); messageContextMenu = picker; search.focus();
  picker.style.left = `${Math.max(8, Math.min(x - 10, innerWidth - 390))}px`; picker.style.top = `${Math.max(8, Math.min(y, innerHeight - 430))}px`;
}

function beginEdit(data) {
  if (data.clientId !== clientId || data.deleted) return;
  editingMessageId = data.id; messageInput.value = data.message || "";
  editingBanner.classList.remove("hidden"); autoResizeTextarea(); messageInput.focus();
}

function cancelEdit() {
  editingMessageId = null; editingBanner.classList.add("hidden"); messageInput.value = "";
  autoResizeTextarea();
}

function deleteForSelf(data) {
  deletedForSelf.add(data.id);
  document.querySelector(`[data-message-id="${CSS.escape(String(data.id))}"]`)?.remove();
  globalTranscript = globalTranscript.filter((item) => item.id !== data.id);
  if (!messageList.querySelector(".message-row:not(#empty-state)")) emptyState.classList.remove("hidden");
  scheduleSessionSave();
}

function applyMessageAction(action) {
  const data = messageRecords.get(action.id);
  if (!data || deletedForSelf.has(action.id)) return;
  if (action.action === "edit") {
    if (action.actorClientId !== data.clientId || typeof action.message !== "string") return;
    data.message = cleanMessage(action.message); data.edited = true; data.editedAt = action.editedAt || new Date().toISOString();
  } else if (action.action === "delete") {
    if (action.actorClientId !== data.clientId) return;
    data.deleted = true; data.message = ""; data.fileUrl = undefined;
  } else if (action.action === "reaction") {
    if (!action.emoji || action.emoji.length > 8) return;
    const reactions = data.reactions || (data.reactions = {});
    const entry = reactions[action.emoji] || { count: 0, users: [] };
    const users = Array.isArray(entry.users) ? entry.users : [];
    const index = users.indexOf(action.actorClientId);
    if (action.remove && index >= 0) users.splice(index, 1);
    else if (!action.remove && index < 0) users.push(action.actorClientId);
    entry.users = users; entry.count = users.length; reactions[action.emoji] = entry;
  } else return;
  updateTranscriptRecord(data);
  document.querySelector(`[data-message-id="${CSS.escape(String(data.id))}"]`)?.replaceWith(buildGlobalMessageRow(data));
}

function buildGlobalMessageRow(data) {
  const name = cleanText(data.name, MAX_NAME_LENGTH) || "anonymous";
  const row = document.createElement("article"); row.className = "message-row"; row.dataset.messageId = String(data.id);
  const own = data.clientId === clientId; if (own) row.classList.add("is-own-message");
  row.addEventListener("contextmenu", (event) => openMessageContextMenu(event, data));
  const avatar = document.createElement("div"); avatar.className = "message-avatar"; avatar.textContent = getInitial(name);
  const bubble = document.createElement("div"); bubble.className = "message-bubble";
  const nameRow = document.createElement("div"); nameRow.className = "message-name-row";
  const nameEl = document.createElement("div"); nameEl.className = "message-name"; nameEl.textContent = name; nameRow.appendChild(nameEl);
  if (!own) {
    const report = document.createElement("button"); report.type = "button"; report.className = "message-report-button";
    report.title = "Report this message"; report.setAttribute("aria-label", `Report message from ${name}`);
    report.textContent = "⚑"; report.addEventListener("click", () => reportMessage(data, name, data.message, report)); nameRow.appendChild(report);
  }
  if (data.edited) { const tag = document.createElement("span"); tag.className = "message-edited-tag"; tag.textContent = "Edited"; nameRow.appendChild(tag); }
  bubble.appendChild(nameRow);
  if (data.deleted) { const deleted = document.createElement("div"); deleted.className = "message-text message-deleted-text"; deleted.textContent = "Message deleted for everyone"; bubble.appendChild(deleted); }
  else if (data.message) { const text = document.createElement("div"); text.className = "message-text"; text.textContent = data.message; bubble.appendChild(text); }
  if (!data.deleted && isRenderableAttachment(data)) bubble.appendChild(buildAttachmentElement(data));
  const time = document.createElement("time"); time.className = "message-time"; const date = new Date(data.sentAt);
  time.textContent = Number.isNaN(date.getTime()) ? "now" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); bubble.appendChild(time);
  const contentStack = document.createElement("div"); contentStack.className = "message-content-stack";
  contentStack.appendChild(bubble); renderReactionSummary(contentStack, data);
  row.append(avatar, contentStack); return row;
}

function openMessageContextMenu(event, data) {
  event.preventDefault(); closeMessageContextMenu();
  const menu = document.createElement("div"); menu.className = "message-context-menu"; menu.setAttribute("role", "menu");
  const add = (label, handler, danger = false) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    if (danger) button.classList.add("is-danger"); button.addEventListener("click", () => { closeMessageContextMenu(); handler(); }); menu.appendChild(button);
  };
  if (data.clientId === clientId && !data.deleted) {
    add("Edit message", () => beginEdit(data)); add("Delete for everyone", () => { sendMessageAction("delete", data); applyMessageAction({ action: "delete", id: data.id, actorClientId: clientId }); }, true);
  }
  add("Delete for yourself", () => deleteForSelf(data), true);
  if (data.clientId !== clientId) add("Report message", () => document.querySelector(`[data-message-id="${CSS.escape(String(data.id))}"] .message-report-button`)?.click());
  const shell = document.createElement("div"); shell.className = "message-actions-popover";
  const quick = createQuickReactionPicker(data, event.clientX, event.clientY);
  shell.append(quick, menu); document.body.appendChild(shell); messageContextMenu = shell;
  const left = Math.max(8, Math.min(event.clientX, innerWidth - Math.max(menu.offsetWidth, quick.offsetWidth) - 8));
  const top = Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - quick.offsetHeight - 16));
  shell.style.left = `${left}px`; shell.style.top = `${top}px`;
  quick.style.top = `${menu.offsetHeight + 8}px`;
}

function renderMessage(payload) {
  const data = payload?.payload ?? payload;

  if (!data || typeof data !== "object") return;

  if (data.action) { applyMessageAction(data); return; }
  if (deletedForSelf.has(data.id) || messageRecords.has(data.id)) return;

  const name = cleanText(data.name, MAX_NAME_LENGTH);
  const message = cleanMessage(data.message);
  const hasFile = isRenderableAttachment(data);
  const isOwnMessage = data.clientId === clientId;

  if (!name || (!message && !hasFile && !data.deleted) || !rememberMessage(data.id)) return;

  data.name = name; data.message = message; data.reactions = data.reactions || {};
  messageRecords.set(data.id, data);

  emptyState.classList.add("hidden");

  const row = document.createElement("article");
  row.className = "message-row";
  row.dataset.messageId = String(data.id);
  row.addEventListener("contextmenu", (event) => openMessageContextMenu(event, data));
  if (isOwnMessage) row.classList.add("is-own-message");

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = getInitial(name);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const nameRow = document.createElement("div");
  nameRow.className = "message-name-row";

  const nameEl = document.createElement("div");
  nameEl.className = "message-name";
  nameEl.textContent = name;
  nameRow.appendChild(nameEl);

  if (!isOwnMessage) {
    const reportBtn = document.createElement("button");
    reportBtn.type = "button";
    reportBtn.className = "message-report-button";
    reportBtn.title = "Report this message";
    reportBtn.setAttribute("aria-label", `Report message from ${name}`);
    reportBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V3"/></svg>';
    reportBtn.addEventListener("click", () => reportMessage(data, name, message, reportBtn));
    nameRow.appendChild(reportBtn);
  }

  bubble.appendChild(nameRow);

  if (message) {
    const messageEl = document.createElement("div");
    messageEl.className = "message-text";
    messageEl.textContent = message;
    bubble.appendChild(messageEl);
  }

  if (data.edited) {
    const editedEl = document.createElement("span"); editedEl.className = "message-edited-tag";
    editedEl.textContent = "Edited"; nameRow.appendChild(editedEl);
  }

  if (data.deleted) {
    const deletedEl = document.createElement("div"); deletedEl.className = "message-text message-deleted-text";
    deletedEl.textContent = "Message deleted for everyone"; bubble.appendChild(deletedEl);
  }

  if (hasFile) {
    bubble.appendChild(buildAttachmentElement(data));
  }

  const metaEl = document.createElement("time");
  metaEl.className = "message-time";
  const sentAt = new Date(data.sentAt);
  metaEl.dateTime = Number.isNaN(sentAt.getTime()) ? "" : sentAt.toISOString();
  metaEl.textContent = Number.isNaN(sentAt.getTime())
    ? "now"
    : sentAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  bubble.appendChild(metaEl);
  const contentStack = document.createElement("div");
  contentStack.className = "message-content-stack";
  contentStack.appendChild(bubble);
  renderReactionSummary(contentStack, data);
  row.append(avatar, contentStack);

  // Smart scroll: only follow new messages if the reader is at the bottom.
  const wasNearBottom = isNearBottom(messageList);
  messageList.appendChild(row);

  // Mirror for soft-reload persistence.
  globalTranscript.push({
    id: typeof data.id === "string" ? data.id : "",
    clientId: typeof data.clientId === "string" ? data.clientId : "",
    name,
    message,
    sentAt: data.sentAt,
    fileName: typeof data.fileName === "string" ? data.fileName : undefined,
    fileType: typeof data.fileType === "string" ? data.fileType : undefined,
    fileSize: typeof data.fileSize === "number" ? data.fileSize : undefined,
    fileUrl: hasFile ? data.fileUrl : undefined,
    edited: Boolean(data.edited),
    editedAt: data.editedAt,
    deleted: Boolean(data.deleted),
    reactions: data.reactions || {}
  });
  if (globalTranscript.length > PERSISTED_GLOBAL_CAP) {
    globalTranscript.splice(0, globalTranscript.length - PERSISTED_GLOBAL_CAP);
  }
  scheduleSessionSave();

  if (wasNearBottom) scrollToBottom();
}

/* ------------------------- Presence ----------------------------- */

/*
 * Presence is used ONLY for an approximate online count.
 * We deliberately do NOT put the display name into presence state.
 * The only presence data is a random browser-session ID + timestamp.
 */
function updateOnlineCount() {
  if (!chatChannel) {
    onlineCount.textContent = "—";
    return;
  }

  const state = chatChannel.presenceState();
  const clients = Object.values(state).flat();
  const uniqueClients = new Set(
    clients
      .map((item) => item?.client_id)
      .filter(Boolean)
  );

  // Include this browser session in the count once subscribed.
  if (isSubscribed) uniqueClients.add(clientId);

  onlineCount.textContent = String(uniqueClients.size || 1);
}

/* ----------------------- Channel setup -------------------------- */

function buildChannel() {
  if (chatChannel) {
    const previousChannel = chatChannel;
    chatChannel = null;
    try {
      supabaseClient.removeChannel(previousChannel);
    } catch (_) {}
  }

  /*
   * Public channel: no authentication/account is required.
   * Broadcast is configured to receive our own message so the sender
   * sees the exact same path as everybody else.
   */
  const channel = supabaseClient.channel(CHANNEL_NAME, {
    config: {
      broadcast: {
        self: true,
        ack: true
      },
      presence: {
        key: clientId
      }
    }
  });

  channel
    .on(
      "broadcast",
      { event: MESSAGE_EVENT },
      (payload) => {
        if (channel === chatChannel) renderMessage(payload);
      }
    )
    .on(
      "presence",
      { event: "sync" },
      () => channel === chatChannel && updateOnlineCount()
    )
    .on(
      "presence",
      { event: "join" },
      () => channel === chatChannel && updateOnlineCount()
    )
    .on(
      "presence",
      { event: "leave" },
      () => channel === chatChannel && updateOnlineCount()
    );

  chatChannel = channel;
  return channel;
}

async function subscribeToChat() {
  if (!supabaseClient) return;

  clearTimeout(reconnectTimer);
  isSubscribed = false;
  setConnectionState("connecting", "Connecting...");

  const channel = buildChannel();

  channel.subscribe(async (status, err) => {
    if (channel !== chatChannel || !currentName) return;

    if (status === "SUBSCRIBED") {
      isSubscribed = true;
      setConnectionState("connected", "Connected");

      try {
        await channel.track({
          client_id: clientId,
          online_at: new Date().toISOString()
        });
      } catch (trackError) {
        console.warn("Presence tracking failed:", trackError);
      }

      updateOnlineCount();
      return;
    }

    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      isSubscribed = false;
      setConnectionState("disconnected", "Disconnected");
      console.error("Realtime channel error:", status, err);
      scheduleReconnect();
      return;
    }

    if (status === "CLOSED") {
      isSubscribed = false;
      setConnectionState("disconnected", "Disconnected");
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!document.hidden && currentName) {
      subscribeToChat();
    }
  }, RECONNECT_DELAY_MS);
}

/* ------------------------ Send message -------------------------- */

async function sendMessage() {
  if (!chatChannel || !isSubscribed) {
    showToast("You are not connected yet.");
    return;
  }

  if (isUploadingFile) {
    showToast("Still uploading your file — hang tight.");
    return;
  }

  const attachment = pendingFile;
  const validation = validateMessage(messageInput.value, Boolean(attachment));

  if (!validation.valid) {
    showToast(validation.message);
    return;
  }

  if (editingMessageId) {
    const data = messageRecords.get(editingMessageId);
    if (data && data.clientId === clientId) {
      data.message = validation.value;
      data.edited = true;
      data.editedAt = new Date().toISOString();
      sendMessageAction("edit", data);
      applyMessageAction({ action: "edit", id: data.id, actorClientId: clientId, message: data.message, editedAt: data.editedAt });
    }
    cancelEdit();
    return;
  }

  const now = Date.now();
  if (now - lastSentAt < MIN_SEND_INTERVAL_MS) {
    showToast("Slow down a little — you can send another message shortly.");
    return;
  }

  lastSentAt = now;
  sendButton.disabled = true;

  /*
   * IMPORTANT:
   * The message text is sent directly through Realtime Broadcast. Nothing is
   * inserted into a Postgres application table. An attached file was already
   * uploaded to Supabase Storage in handleFileSelection() — only its public
   * URL travels in this payload, not the file itself.
   */
  try {
    const result = await chatChannel.send({
      type: "broadcast",
      event: MESSAGE_EVENT,
      payload: {
        id: `${clientId}-${now}`,
        clientId,
        name: currentName,
        message: validation.value,
        sentAt: new Date().toISOString(),
        ...(attachment
          ? {
              fileName: attachment.name,
              fileType: attachment.type,
              fileSize: attachment.size,
              fileUrl: attachment.url
            }
          : {})
      }
    });

    if (result !== "ok" && result?.status !== "ok") {
      console.error("Broadcast send result:", result);
      showToast("Message could not be sent. Please try again.");
      return;
    }

    messageInput.value = "";
    autoResizeTextarea();
    resetAttachmentState();
    messageInput.focus();
  } catch (error) {
    console.error("Broadcast send failed:", error);
    showToast("Message could not be sent. Check your connection.");
  } finally {
    sendButton.disabled = false;
  }
}

/* --------------------- Private rooms: core ---------------------- */

function isValidRoomCode(value) {
  return typeof value === "string" && ROOM_CODE_PATTERN.test(value);
}

function totalUnreadCount() {
  let total = 0;
  privateRooms.forEach((room) => {
    total += room.unread;
  });
  return total;
}

const BASE_DOCUMENT_TITLE = document.title;

function updateUnreadBadge() {
  const total = totalUnreadCount();
  privateUnreadBadge.textContent = String(total);
  privateUnreadBadge.classList.toggle("hidden", total === 0);
  document.title = total > 0 ? `(${total}) ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
  if (currentName) scheduleSessionSave();
}

/*
 * Re-renders the sidebar conversation list. Pure re-render on every change;
 * the list is tiny (capped at MAX_PRIVATE_ROOMS).
 */
function renderRoomsDirectory() {
  if (!currentName) return;

  conversationList.textContent = "";
  const rooms = Array.from(privateRooms.values()).sort((a, b) =>
    String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || ""))
  );

  rooms.forEach((room) => {
    const item = document.createElement("li");
    item.className = "private-item room-item";
    if (room.code === activeRoomCode) item.classList.add("is-active");
    if (room.unread > 0) item.classList.add("has-unread");

    const avatar = document.createElement("span");
    avatar.className = "private-item-avatar";
    avatar.textContent = "#";

    const meta = document.createElement("span");
    meta.className = "private-item-meta";

    const nameEl = document.createElement("span");
    nameEl.className = "private-item-name";
    nameEl.textContent = roomDisplayName(room);

    const previewEl = document.createElement("span");
    previewEl.className = "private-item-preview";
    if (typeof room.preview === "string" && room.preview) {
      previewEl.textContent = room.preview;
    } else if (room.subscribed) {
      previewEl.textContent =
        room.memberCount > 0 ? `${room.memberCount} here` : "waiting for others…";
    } else {
      previewEl.textContent = "connecting…";
    }

    meta.append(nameEl, previewEl);

    const badge = document.createElement("span");
    badge.className = "private-item-badge";
    badge.textContent = String(room.unread);
    if (room.unread === 0) badge.classList.add("hidden");

    item.append(avatar, meta, badge);
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.setAttribute("aria-label", `Open room ${room.code}`);

    const open = () => openRoom(room.code);
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    conversationList.appendChild(item);
  });

  conversationListEmpty.classList.toggle("hidden", rooms.length > 0);
}

function setThreadVisible(hasActive) {
  privateThreadEmpty.classList.toggle("hidden", hasActive);
  privateThreadActive.classList.toggle("hidden", !hasActive);
}

function autoResizePrivateTextarea() {
  privateMessageInput.style.height = "auto";
  privateMessageInput.style.height = `${privateMessageInput.scrollHeight}px`;
}

function showStartView() {
  activeRoomCode = null;
  setThreadVisible(false);
  // Mobile: the start view lives in the thread panel — reveal it.
  privateLayout.classList.add("show-thread");
  renderRoomsDirectory();
}

async function createPrivateRoom() {
  if (!supabaseClient || !chatChannel || !isSubscribed) {
    showToast("You are not connected yet.");
    return;
  }

  if (privateRooms.size >= MAX_PRIVATE_ROOMS) {
    showToast(`You can only be in ${MAX_PRIVATE_ROOMS} rooms at once.`);
    return;
  }

  createRoomButton.disabled = true;

  try {
    // Retry on the (unlikely) chance we already hold this exact code.
    let code = generateRoomCode();
    while (privateRooms.has(code)) code = generateRoomCode();

    const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const saltB64 = bytesToBase64(saltBytes);

    const room = createRoomShell(code, saltB64);
    room.name = cleanText(roomNameInput.value, MAX_NAME_LENGTH);
    roomNameInput.value = "";
    privateRooms.set(code, room);

    try {
      room.key = await deriveRoomKey(code, saltB64);
    } catch (error) {
      console.error("Room key derivation failed:", error);
      privateRooms.delete(code);
      showToast("Could not create the encrypted room. Please try again.");
      return;
    }

    subscribeRoomChannel(room);
    renderRoomsDirectory();
    openRoom(code);
    scheduleSessionSave();
    showToast(`Room ${code} created — share the code to invite people.`);
  } finally {
    createRoomButton.disabled = false;
  }
}

async function joinPrivateRoom(rawCode) {
  const code = cleanText(rawCode, ROOM_CODE_LENGTH + 8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!ROOM_CODE_PATTERN.test(code)) {
    joinRoomError.textContent = "Enter the 4-character room code.";
    return;
  }

  if (!supabaseClient || !chatChannel || !isSubscribed) {
    showToast("You are not connected yet.");
    return;
  }

  if (privateRooms.size >= MAX_PRIVATE_ROOMS) {
    showToast(`You can only be in ${MAX_PRIVATE_ROOMS} rooms at once.`);
    return;
  }

  if (privateRooms.has(code)) {
    openRoom(code);
    setChatMode("private");
    return;
  }

  joinRoomButton.disabled = true;
  joinRoomError.textContent = "";
  const originalButtonLabel = joinRoomButton.textContent;
  joinRoomButton.textContent = "Checking…";

  /*
   * The salt is unknown before the first frame arrives, so we subscribe
   * first and derive the key lazily when a frame reveals it. Until then,
   * the room renders as "connecting…".
   */
  const room = createRoomShell(code, null);
  privateRooms.set(code, room);
  subscribeRoomChannel(room);

  try {
    const roomIsReal = await waitForRoomPresence(room);

    if (!roomIsReal) {
      leaveRoom(room);
      joinRoomError.textContent = `Room ${code} not found — check the code and try again.`;
      return;
    }

    renderRoomsDirectory();
    openRoom(code);
    setChatMode("private");
    scheduleSessionSave();

    setTimeout(() => privateMessageInput.focus(), 120);
  } finally {
    joinRoomButton.disabled = false;
    joinRoomButton.textContent = originalButtonLabel;
  }
}

/*
 * There's no server-side room registry — a code only corresponds to a real
 * room for as long as somebody else's browser is subscribed to it. Without
 * this check, joining a code nobody ever created would silently open an
 * empty room that waits forever with no indication the code was wrong.
 * Resolves true the moment presence reveals another occupant, or false
 * after ROOM_JOIN_TIMEOUT_MS with nobody else having shown up.
 */
function waitForRoomPresence(room) {
  return new Promise((resolve) => {
    if (room.memberCount > 1) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      room.onPresenceConfirmed = null;
      resolve(false);
    }, ROOM_JOIN_TIMEOUT_MS);

    room.onPresenceConfirmed = () => {
      clearTimeout(timer);
      room.onPresenceConfirmed = null;
      resolve(true);
    };
  });
}

function createRoomShell(code, saltB64) {
  return {
    code,
    saltB64,
    name: "",
    key: null,
    unread: 0,
    subscribed: false,
    memberCount: 0,
    members: new Map(), // clientId -> name (from room presence)
    // Gates join/leave system notices on the very first presence sync of a
    // (re)subscribe — without this, restoring a room after a soft reload
    // (or any resubscribe) re-announces everyone already present as if
    // they'd just joined, since `members` always starts empty.
    rosterInitialized: false,
    emptySince: Date.now(), // expiry timer starts while only you are here
    lastActivityAt: "",
    preview: "",
    recentIds: new Set(),
    messageRecords: new Map(),
    channel: null,
    // Set only while joinPrivateRoom is waiting to confirm the room is real
    // (see waitForRoomPresence) — called the moment presence shows someone
    // else on the channel.
    onPresenceConfirmed: null,
    listRows: []
  };
}

async function ensureRoomKey(room, saltB64) {
  if (room.key) return true;
  if (!saltB64) return false;

  // Keep the originally created salt; only derive when missing (join path).
  if (!room.saltB64) room.saltB64 = saltB64;

  room.key = await deriveRoomKey(room.code, room.saltB64);
  renderRoomsDirectory();
  updateRoomHeader(room);
  return Boolean(room.key);
}

function subscribeRoomChannel(room) {
  if (room.channel) {
    try {
      supabaseClient.removeChannel(room.channel);
    } catch (_) {}
  }
  room.rosterInitialized = false;

  const channel = supabaseClient.channel(privateChannelName(room.code), {
    config: {
      broadcast: { self: true, ack: true },
      presence: { key: clientId }
    }
  });

  channel
    .on(
      "broadcast",
      { event: PRIVATE_MESSAGE_EVENT },
      (payload) => {
        if (privateRooms.get(room.code) === room) handleRoomMessage(room, payload);
      }
    )
    .on(
      "broadcast",
      { event: ROOM_META_EVENT },
      (payload) => {
        if (privateRooms.get(room.code) === room) handleRoomMeta(room, payload);
      }
    )
    .on("presence", { event: "sync" }, () => {
      if (privateRooms.get(room.code) !== room) return;

      // Roster: clientId -> display name (presence on the room channel
      // carries the name; the channel is code-gated so this is private).
      const seen = new Map();
      Object.values(channel.presenceState())
        .flat()
        .forEach((entry) => {
          const id = typeof entry?.client_id === "string" ? entry.client_id : "";
          if (!id || id === clientId) return;
          const name = cleanText(entry.name, MAX_NAME_LENGTH) || "anonymous";
          if (!seen.has(id)) seen.set(id, name);
        });
      seen.set(clientId, currentName);
      room.memberCount = seen.size;

      if (room.memberCount > 1 && room.onPresenceConfirmed) {
        room.onPresenceConfirmed();
      }

      // The first sync after a (re)subscribe just fills the roster — those
      // people were already here, they didn't just join.
      const isFirstSync = !room.rosterInitialized;
      room.rosterInitialized = true;

      // Join/leave diffs → system notices.
      room.members.forEach((name, id) => {
        if (!seen.has(id)) {
          room.members.delete(id);
          if (!isFirstSync) appendRoomSystemRow(room, `${name} left the room`);
        }
      });
      seen.forEach((name, id) => {
        if (!room.members.has(id)) {
          room.members.set(id, name);
          // Own presence appearing is not worth a notice.
          if (id !== clientId && !isFirstSync) {
            appendRoomSystemRow(room, `${name} joined the room`);
          }
        }
      });

      const grew = room.memberCount > (room.prevMemberCount || 0);
      room.prevMemberCount = room.memberCount;

      if (room.memberCount > 1) {
        room.emptySince = null; // Someone else is here — pause expiry.
      } else if (!room.emptySince) {
        room.emptySince = Date.now(); // Alone again — restart the timer.
      }

      renderRoomsDirectory();
      renderRoomMembers(room);
      updateRoomHeader(room);
      // A new member just appeared — make sure they learn the room name
      // and (if we hold it) the salt, so they can send without waiting
      // on us to message first.
      if (grew) sendRoomMeta(room);
    });

  channel.subscribe(async (status) => {
    if (privateRooms.get(room.code) !== room) return;

    if (status === "SUBSCRIBED") {
      room.subscribed = true;
      try {
        await channel.track({
          client_id: clientId,
          name: currentName,
          online_at: new Date().toISOString()
        });
      } catch (_) {}
      sendRoomMeta(room);
    } else if (
      status === "CHANNEL_ERROR" ||
      status === "TIMED_OUT" ||
      status === "CLOSED"
    ) {
      room.subscribed = false;
    }

    renderRoomsDirectory();
    updateRoomHeader(room);
  });

  room.channel = channel;
}

/*
 * Room-name announcement. The channel itself is derived from the code, so
 * only code-holders ever see this frame — the name leaks nothing new.
 */
function sendRoomMeta(room) {
  if (!room.channel || !room.subscribed) return;
  // Nothing worth announcing yet — no name, and no salt to hand a joiner.
  if (!room.name && !room.saltB64) return;
  room.channel
    .send({
      type: "broadcast",
      event: ROOM_META_EVENT,
      payload: { v: 1, name: room.name || undefined, s: room.saltB64 || undefined, by: clientId }
    })
    .catch(() => {});
}

/*
 * A joiner has no salt until either a chat message or this meta frame
 * reveals it (see handleRoomMessage). Without this, a room stays unusable
 * for the joiner until the host happens to send first.
 */
async function handleRoomMeta(room, payload) {
  const data = payload?.payload ?? payload;
  if (!data || typeof data !== "object" || data.v !== 1) return;

  if (typeof data.s === "string" && data.s && !room.key) {
    await ensureRoomKey(room, data.s);
  }

  if (typeof data.name !== "string") return;

  const name = cleanText(data.name, MAX_NAME_LENGTH);
  if (!name || name === room.name) return;

  room.name = name;
  renderRoomsDirectory();
  updateRoomHeader(room);
  scheduleSessionSave();
}

function roomDisplayName(room) {
  return room.name || `Room ${room.code}`;
}

function updateRoomHeader(room) {
  if (activeRoomCode !== room.code) return;

  roomTitle.textContent = roomDisplayName(room);
  roomCodeLabel.textContent = room.code;
  roomMembersCount.textContent = String(room.memberCount || 1);

  const state = room.subscribed ? "connected" : "connecting";
  roomStatus.dataset.state = state;
  roomStatusText.textContent = room.subscribed
    ? room.memberCount > 1
      ? `${room.memberCount} people · encrypted`
      : "encrypted · waiting for others…"
    : "connecting…";
}

function renderRoomMembers(room) {
  if (activeRoomCode !== room.code) return;

  roomMembersList.textContent = "";
  const names = Array.from(room.members.values()).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) names.push(currentName);

  names.forEach((name) => {
    const item = document.createElement("li");
    item.className = "room-member-item";
    if (name === currentName) {
      item.classList.add("is-self");
      const label = document.createElement("span");
      label.textContent = name;
      const you = document.createElement("span");
      you.className = "room-member-you";
      you.textContent = "you";
      item.append(label, you);
    } else {
      item.textContent = name;
    }
    roomMembersList.appendChild(item);
  });
}

function toggleRoomMembersPanel() {
  const room = privateRooms.get(activeRoomCode);
  if (!room) return;
  const hidden = roomMembersPanel.classList.toggle("hidden");
  if (!hidden) {
    renderRoomMembers(room);
  }
}

function openRoom(code) {
  const room = privateRooms.get(code);
  if (!room) return;

  clearPrivateAttachment();
  activeRoomCode = code;
  room.unread = 0;
  updateUnreadBadge();
  renderRoomsDirectory();
  setThreadVisible(true);
  privateLayout.classList.add("show-thread");

  roomAvatar.textContent = "#";
  updateRoomHeader(room);
  renderRoomMembers(room);

  // Restore this session's cached transcript for the room. Rebuilt fresh
  // from data each time — a cached DOM clone would have lost its
  // attachment-menu click handlers (cloneNode() doesn't copy listeners
  // added via addEventListener).
  privateMessageList.querySelectorAll(".message-row").forEach((el) => el.remove());
  privateEmptyState.classList.remove("hidden");
  room.listRows.forEach((rowData) => {
    const node =
      rowData.type === "system"
        ? buildSystemRowElement(rowData.text)
        : buildRoomMessageRow(
            rowData.senderName,
            rowData.messageText,
            rowData.sentAtRaw,
            rowData.isOwnMessage,
            rowData.attachmentData,
            room,
            rowData
          );
    privateMessageList.appendChild(node);
  });

  if (privateMessageList.querySelector(".message-row")) {
    privateEmptyState.classList.add("hidden");
  }

  privateMessageList.scrollTop = privateMessageList.scrollHeight;
  setTimeout(() => autoResizePrivateTextarea(), 50);
  setTimeout(() => privateMessageInput.focus(), 100);
}

function closeActiveRoom() {
  const room = privateRooms.get(activeRoomCode);
  if (!room) return;

  leaveRoom(room);
  showStartView();
  setThreadVisible(false);
}

function leaveRoom(room) {
  if (room.channel && supabaseClient) {
    try {
      supabaseClient.removeChannel(room.channel);
    } catch (_) {}
  }
  privateRooms.delete(room.code);

  if (activeRoomCode === room.code) activeRoomCode = null;
  renderRoomsDirectory();
  updateUnreadBadge();
  scheduleSessionSave();
}

async function sendPrivateMessage() {
  const room = privateRooms.get(activeRoomCode);
  if (!room) return;

  if (!room.channel || !room.subscribed) {
    showToast("The room isn't connected yet.");
    return;
  }

  if (isUploadingPrivateFile) {
    showToast("Still uploading your file — hang tight.");
    return;
  }

  const attachment = privatePendingFile;
  const validation = validateMessage(privateMessageInput.value, Boolean(attachment));
  if (!validation.valid) {
    showToast(validation.message);
    return;
  }

  if (editingPrivateMessage?.room === room) {
    const data = editingPrivateMessage.data;
    if (data.clientId === clientId && !data.deleted) {
      data.message = validation.value; data.edited = true;
      await sendPrivateAction(room, data, { type: "edit", message: data.message });
      applyPrivateMessageAction(room, data.id, { c: clientId, a: { type: "edit", id: data.id, message: data.message } });
    }
    editingPrivateMessage = null; privateMessageInput.value = ""; autoResizePrivateTextarea(); return;
  }

  const now = Date.now();
  if (now - lastSentAt < MIN_SEND_INTERVAL_MS) {
    showToast("Slow down a little — you can send another message shortly.");
    return;
  }
  lastSentAt = now;
  privateSendButton.disabled = true;

  /*
   * Only ciphertext leaves the browser. The plaintext envelope carries the
   * sender name, message text and timestamp — all inside AES-GCM.
   */
  try {
    if (!room.key) throw new Error("Room key not derived yet");

    const messageId = `${clientId}-${now}`;

    const ct = await encryptPrivatePayload(room.key, {
      c: clientId,
      n: currentName,
      m: validation.value,
      t: new Date().toISOString(),
      id: messageId,
      ...(attachment
        ? {
            f: {
              fileName: attachment.name,
              fileType: attachment.type,
              fileSize: attachment.size,
              fileUrl: attachment.url
            }
          }
        : {})
    });

    const result = await room.channel.send({
      type: "broadcast",
      event: PRIVATE_MESSAGE_EVENT,
      payload: {
        v: 1,
        id: messageId,
        s: room.saltB64,
        ct
      }
    });

    if (result !== "ok" && result?.status !== "ok") {
      console.error("Room broadcast result:", result);
      showToast("Message could not be sent. Please try again.");
      return;
    }

    privateMessageInput.value = "";
    autoResizePrivateTextarea();
    resetPrivateAttachmentState();
    privateMessageInput.focus();
  } catch (error) {
    console.error("Room send failed:", error);
    showToast("Message could not be sent. Check your connection.");
  } finally {
    privateSendButton.disabled = false;
  }
}

function rememberRoomId(room, id) {
  if (!id) return true;
  if (room.recentIds.has(id)) return false;

  room.recentIds.add(id);
  if (room.recentIds.size > PRIVATE_RECENT_IDS_CAP) {
    room.recentIds.delete(room.recentIds.values().next().value);
  }
  return true;
}

async function handleRoomMessage(room, payload) {
  const data = payload?.payload ?? payload;
  if (!data || typeof data !== "object") return;

  if (data.v !== 1) return;
  if (!rememberRoomId(room, data.id)) return;
  if (typeof data.ct !== "string" || data.ct.length === 0) return;
  if (typeof data.s !== "string" || !data.s) return;

  // Cheap upper bound before base64-decoding + AES-GCM work.
  if (data.ct.length > MAX_MESSAGE_LENGTH * 2 + 64) return;

  // Adopt the room salt from frames if we joined without it.
  if (!room.key && !(await ensureRoomKey(room, data.s))) return;
  // A frame with a different salt belongs to another incarnation of this
  // code — its ciphertext would fail authentication anyway.
  if (room.saltB64 && data.s !== room.saltB64) return;

  let plain;
  try {
    plain = await decryptPrivatePayload(room.key, data.ct);
  } catch (_) {
    return; // Wrong key / tampered frame — dropped silently.
  }

  if (plain?.a) { applyPrivateMessageAction(room, data.id, plain); return; }

  if (!plain || typeof plain !== "object" || typeof plain.m !== "string") return;

  const message = cleanMessage(plain.m);
  const attachmentData =
    plain.f && typeof plain.f === "object" && isRenderableAttachment(plain.f)
      ? {
          fileName: plain.f.fileName,
          fileType: plain.f.fileType,
          fileSize: plain.f.fileSize,
          fileUrl: plain.f.fileUrl
        }
      : null;

  if (!message && !attachmentData) return;

  // Sender name comes from INSIDE the authenticated envelope.
  const senderName = cleanText(plain.n, MAX_NAME_LENGTH) || "anonymous";

  // Own-message detection uses the session ID inside the envelope, so two
  // people sharing a display name are never confused.
  const isOwnMessage = typeof plain.c === "string" && plain.c === clientId;
  const messageData = {
    id: data.id, clientId: plain.c, name: senderName, message, sentAt: plain.t,
    attachmentData, reactions: plain.r || {}, edited: Boolean(plain.e), deleted: Boolean(plain.d)
  };
  room.messageRecords.set(data.id, messageData);

  // Mirror for soft-reload persistence (single choke point for both the
  // live-view and background-cache paths).
  room.transcript = room.transcript || [];
  room.transcript.push({
    n: senderName, c: plain.c, id: data.id,
    m: message,
    t: plain.t,
    own: isOwnMessage,
    f: attachmentData
    , id: data.id, reactions: messageData.reactions, edited: messageData.edited, deleted: messageData.deleted
  });
  if (room.transcript.length > PERSISTED_ROOM_ROWS_CAP) {
    room.transcript.splice(0, room.transcript.length - PERSISTED_ROOM_ROWS_CAP);
  }

  // Only paint into the DOM when this room is actually on screen; otherwise
  // the bubble would bleed into whichever thread is currently visible.
  const isViewing = currentMode === "private" && activeRoomCode === room.code;
  if (isViewing) {
    appendRoomMessageRow(room, senderName, message, plain.t, isOwnMessage, attachmentData, messageData);
  } else {
    cacheRoomRow(room, senderName, message, plain.t, isOwnMessage, attachmentData, messageData);
  }

  room.lastActivityAt = new Date().toISOString();
  room.preview = message
    ? message.length > 42
      ? `${message.slice(0, 42)}…`
      : message
    : `📎 ${cleanText(attachmentData.fileName, 24)}`;

  if (!isOwnMessage && !isViewing) {
    room.unread = Math.min(room.unread + 1, 999);
    playNotificationSound();
  }

  updateUnreadBadge();
  renderRoomsDirectory();
  scheduleSessionSave();

  if (isViewing) scrollToBottom(privateMessageList);
}

function buildSystemRowElement(text) {
  const row = document.createElement("article");
  row.className = "message-row system-row";
  const line = document.createElement("p");
  line.className = "system-row-text";
  line.textContent = text;
  row.appendChild(line);
  return row;
}

/* Local system notice (join/leave) — derived from presence, never broadcast. */
function appendRoomSystemRow(room, text) {
  // Paint live only if this room is on screen.
  if (currentMode === "private" && activeRoomCode === room.code) {
    privateEmptyState.classList.add("hidden");
    privateMessageList.appendChild(buildSystemRowElement(text));
    scrollToBottom(privateMessageList);
  }

  room.transcript = room.transcript || [];
  room.transcript.push({ sys: true, m: text, t: new Date().toISOString() });
  if (room.transcript.length > PERSISTED_ROOM_ROWS_CAP) {
    room.transcript.splice(0, room.transcript.length - PERSISTED_ROOM_ROWS_CAP);
  }

  // Stored as data, not a DOM clone — cloneNode() drops addEventListener
  // handlers, which would leave attachment menus dead once this row is
  // rebuilt on room re-open (see openRoom()).
  room.listRows.push({ type: "system", text });
  if (room.listRows.length > 200) room.listRows.shift();
  scheduleSessionSave();
}

/*
 * Builds one bubble for a room thread. The detached clone is cached so
 * switching rooms restores history exactly as rendered; the live node is
 * appended only when the caller knows the room is on screen.
 */
function buildRoomMessageRow(senderName, messageText, sentAtRaw, isOwnMessage, attachmentData, room, messageData = {}) {
  const row = document.createElement("article");
  row.className = "message-row private-message-row";
  if (messageData.id) row.dataset.messageId = String(messageData.id);
  row.dataset.own = isOwnMessage ? "true" : "false";
  if (isOwnMessage) row.classList.add("is-own-message");
  if (messageData.id) row.addEventListener("contextmenu", (event) => openPrivateMessageContextMenu(event, messageData, room));

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = getInitial(senderName);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  const lockEl = document.createElement("span");
  lockEl.className = "message-lock-icon";
  lockEl.title = "End-to-end encrypted";
  lockEl.setAttribute("aria-label", "End-to-end encrypted");
  lockEl.innerHTML =
    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  const nameRow = document.createElement("div");
  nameRow.className = "message-name-row";

  const nameEl = document.createElement("div");
  nameEl.className = "message-name";
  nameEl.textContent = senderName;
  nameRow.appendChild(lockEl);
  nameRow.appendChild(nameEl);

  bubble.appendChild(nameRow);

  if (messageText) {
    const messageEl = document.createElement("div");
    messageEl.className = "message-text";
    // textContent only — user content is never parsed as HTML.
    messageEl.textContent = messageText;
    bubble.appendChild(messageEl);
  }

  if (messageData.edited) {
    const editedEl = document.createElement("span"); editedEl.className = "message-edited-tag";
    editedEl.textContent = "Edited"; nameRow.appendChild(editedEl);
  }
  if (messageData.deleted) {
    const deletedEl = document.createElement("div"); deletedEl.className = "message-text message-deleted-text";
    deletedEl.textContent = "Message deleted for everyone"; bubble.appendChild(deletedEl);
  }

  if (attachmentData && !messageData.deleted) {
    bubble.appendChild(buildAttachmentElement(attachmentData, room));
  }

  const metaEl = document.createElement("time");
  metaEl.className = "message-time";
  const sentDate = new Date(sentAtRaw);
  metaEl.dateTime = Number.isNaN(sentDate.getTime()) ? "" : sentDate.toISOString();
  metaEl.textContent = Number.isNaN(sentDate.getTime())
    ? "now"
    : sentDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  bubble.appendChild(metaEl);
  const contentStack = document.createElement("div"); contentStack.className = "message-content-stack";
  contentStack.appendChild(bubble); renderReactionSummary(contentStack, messageData, (item, emoji) => togglePrivateReaction(room, item, emoji));
  row.append(avatar, contentStack);
  return row;
}

async function sendPrivateAction(room, messageData, action) {
  if (!room?.key || !room.channel || !messageData?.id) return;
  const ct = await encryptPrivatePayload(room.key, {
    c: clientId, t: new Date().toISOString(), a: { type: action.type, id: messageData.id, ...action }
  });
  room.channel.send({ type: "broadcast", event: PRIVATE_MESSAGE_EVENT, payload: { v: 1, id: `${clientId}-${Date.now()}-action`, s: room.saltB64, ct }}).catch(() => {});
}

function refreshPrivateMessage(room, messageData) {
  if (activeRoomCode !== room.code) return;
  const old = privateMessageList.querySelector(`[data-message-id="${CSS.escape(String(messageData.id))}"]`);
  if (old) old.replaceWith(buildRoomMessageRow(messageData.name, messageData.message, messageData.sentAt, messageData.clientId === clientId, messageData.attachmentData, room, messageData));
}

function togglePrivateReaction(room, data, emoji) {
  const reactions = data.reactions || (data.reactions = {}); const entry = reactions[emoji] || { count: 0, users: [] };
  const users = Array.isArray(entry.users) ? entry.users : []; const index = users.indexOf(clientId); const remove = index >= 0;
  if (remove) users.splice(index, 1); else users.push(clientId);
  entry.users = users; entry.count = users.length; reactions[emoji] = entry; refreshPrivateMessage(room, data);
  sendPrivateAction(room, data, { emoji, remove }).catch(() => {});
}

function applyPrivateMessageAction(room, frameId, plain) {
  const action = plain.a; const data = room.messageRecords.get(action.id); if (!data) return;
  if (!action.id || !action.type) return;
  if (action.type === "edit" && plain.c === data.clientId) { data.message = cleanMessage(action.message || ""); data.edited = true; }
  else if (action.type === "delete" && plain.c === data.clientId) { data.deleted = true; data.message = ""; data.attachmentData = null; }
  else if (action.type === "reaction") {
    const reactions = data.reactions || (data.reactions = {}); const entry = reactions[action.emoji] || { count: 0, users: [] }; const users = entry.users || [];
    const index = users.indexOf(plain.c); if (action.remove && index >= 0) users.splice(index, 1); else if (!action.remove && index < 0) users.push(plain.c);
    entry.users = users; entry.count = users.length; reactions[action.emoji] = entry;
  } else return;
  room.listRows = room.listRows.map((row) => row.id === data.id ? { ...row, messageText: data.message, attachmentData: data.attachmentData, reactions: data.reactions, edited: data.edited, deleted: data.deleted } : row);
  room.transcript = (room.transcript || []).map((row) => row.id === data.id ? { ...row, m: data.message, f: data.attachmentData, reactions: data.reactions, edited: data.edited, deleted: data.deleted } : row);
  refreshPrivateMessage(room, data); scheduleSessionSave();
}

function openPrivateMessageContextMenu(event, data, room) {
  event.preventDefault(); closeMessageContextMenu();
  const menu = document.createElement("div"); menu.className = "message-context-menu";
  const add = (label, handler, danger = false) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; if (danger) button.classList.add("is-danger"); button.onclick = () => { closeMessageContextMenu(); handler(); }; menu.appendChild(button); };
  if (data.clientId === clientId && !data.deleted) {
    add("Edit message", () => { editingPrivateMessage = { room, data }; privateMessageInput.value = data.message || ""; privateMessageInput.focus(); autoResizePrivateTextarea(); });
    add("Delete for everyone", () => { sendPrivateAction(room, data, { type: "delete" }).catch(() => {}); applyPrivateMessageAction(room, data.id, { c: clientId, a: { type: "delete", id: data.id } }); }, true);
  }
  add("Delete for yourself", () => { room.listRows = room.listRows.filter((row) => row.id !== data.id); room.transcript = (room.transcript || []).filter((row) => row.id !== data.id); document.querySelector(`[data-message-id="${CSS.escape(String(data.id))}"]`)?.remove(); scheduleSessionSave(); }, true);
  const shell = document.createElement("div"); shell.className = "message-actions-popover"; const quick = createQuickReactionPicker(data, event.clientX, event.clientY, (item, emoji) => togglePrivateReaction(room, item, emoji)); shell.append(quick, menu); document.body.appendChild(shell); messageContextMenu = shell;
  const top = Math.max(58, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)); shell.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - quick.offsetWidth - 8))}px`; shell.style.top = `${top}px`;
  quick.style.top = `-48px`;
}

function cacheRoomRow(room, senderName, messageText, sentAtRaw, isOwnMessage, attachmentData, messageData = {}) {
  // Data, not a built-and-cloned DOM node — see the note in
  // appendRoomSystemRow for why cloneNode() isn't safe here (it would
  // silently drop the attachment menu's click handlers).
  room.listRows.push({
    type: "message",
    senderName,
    messageText,
    sentAtRaw,
    isOwnMessage,
    attachmentData
    , id: messageData.id, reactions: messageData.reactions || {}, edited: Boolean(messageData.edited), deleted: Boolean(messageData.deleted)
  });
  if (room.listRows.length > 200) room.listRows.shift();
}

function appendRoomMessageRow(room, senderName, messageText, sentAtRaw, isOwnMessage, attachmentData, messageData = {}) {
  privateEmptyState.classList.add("hidden");

  const row = buildRoomMessageRow(senderName, messageText, sentAtRaw, isOwnMessage, attachmentData, room, messageData);

  const wasNearBottom = isNearBottom(privateMessageList);
  privateMessageList.appendChild(row);

  room.listRows.push({
    type: "message",
    senderName,
    messageText,
    sentAtRaw,
    isOwnMessage,
    attachmentData
    , id: messageData.id, reactions: messageData.reactions || {}, edited: Boolean(messageData.edited), deleted: Boolean(messageData.deleted)
  });
  if (room.listRows.length > 200) room.listRows.shift();

  if (wasNearBottom) scrollToBottom(privateMessageList);
}

/*
 * Rooms that stay empty (only you, or nobody) for 10 minutes are closed
 * automatically to keep the sidebar clean.
 */
function checkRoomExpiries() {
  const now = Date.now();
  const expired = [];
  privateRooms.forEach((room) => {
    if (
      room.emptySince !== null &&
      room.emptySince !== undefined &&
      now - room.emptySince >= ROOM_EMPTY_EXPIRY_MS
    ) {
      expired.push(room);
    }
  });

  expired.forEach((room) => {
    leaveRoom(room);
    showToast(`Room ${room.code} expired — it was empty for 10 minutes.`);
  });
  return expired.length;
}

setInterval(checkRoomExpiries, ROOM_EXPIRY_CHECK_INTERVAL_MS);

/* Tears down every room channel + wipes keys/history from memory. */
async function teardownPrivateRooms() {
  clearPrivateAttachment();
  privateRooms.forEach((room) => {
    if (room.channel && supabaseClient) {
      try {
        supabaseClient.removeChannel(room.channel);
      } catch (_) {}
    }
  });

  privateRooms.clear();
  activeRoomCode = null;

  roomTitle.textContent = "Room ····";
  roomCodeLabel.textContent = "····";
  roomStatus.dataset.state = "connecting";
  roomStatusText.textContent = "connecting…";

  conversationList.textContent = "";
  conversationListEmpty.classList.remove("hidden");
  privateMessageList.querySelectorAll(".message-row").forEach((el) => el.remove());
  privateEmptyState.classList.remove("hidden");

  setThreadVisible(false);
  privateLayout.classList.remove("show-thread");
  privateMessageInput.value = "";
  autoResizePrivateTextarea();
  updateUnreadBadge();
}
/* -------------------------- Lifecycle ---------------------------- */

async function startChat(name) {
  if (!initializeSupabase()) return;

  currentName = name;
  setChatMode("global");
  currentUserName.textContent = currentName;
  userAvatar.textContent = getInitial(currentName);

  // Fresh in-memory UI: there is intentionally no history fetch.
  messageList.querySelectorAll(".message-row").forEach((el) => el.remove());
  recentMessageIds.clear();
  globalTranscript = [];
  messageRecords.clear();
  deletedForSelf.clear();
  reportedMessageIds.clear();
  emptyState.classList.remove("hidden");

  // Private rooms: fresh ephemeral state every session.
  await teardownPrivateRooms().catch(() => {});
  joinRoomError.textContent = "";
  roomCodeInput.value = "";

  welcomeScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");

  await subscribeToChat();
  scheduleSessionSave();

  setTimeout(() => messageInput.focus(), 150);
}

async function leaveChat() {
  currentName = "";
  isSubscribed = false;

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearSavedSession();
  globalTranscript = [];
  messageRecords.clear();
  deletedForSelf.clear();
  reportedMessageIds.clear();

  await teardownPrivateRooms().catch(() => {});

  if (chatChannel && supabaseClient) {
    try {
      await chatChannel.untrack();
    } catch (_) {}

    try {
      await supabaseClient.removeChannel(chatChannel);
    } catch (_) {}
  }

  chatChannel = null;

  // Clear the in-memory chat immediately.
  messageList.querySelectorAll(".message-row").forEach((el) => el.remove());
  recentMessageIds.clear();
  emptyState.classList.remove("hidden");
  messageInput.value = "";
  clearAttachment();
  autoResizeTextarea();

  chatScreen.classList.add("hidden");
  welcomeScreen.classList.remove("hidden");

  setConnectionState("connecting", "Connecting...");
  nameInput.value = "";
  nameInput.focus();
}

/* --------------------------- Events ------------------------------ */

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const validation = validateName(nameInput.value);

  if (!validation.valid) {
    setNameError(validation.message);
    nameInput.focus();
    return;
  }

  setNameError("");
  startButton.disabled = true;

  await startChat(validation.value);

  startButton.disabled = false;
});

nameInput.addEventListener("input", () => setNameError(""));

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendMessage();
});

messageInput.addEventListener("input", () => {
  autoResizeTextarea();
});

messageInput.addEventListener("keydown", async (event) => {
  // isComposing guards IME input (Japanese/Chinese/Korean etc.) — Enter
  // there commits a candidate, it isn't a request to send.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    await sendMessage();
  }
});

leaveButton.addEventListener("click", leaveChat);
cancelEditButton.addEventListener("click", cancelEdit);
document.addEventListener("click", (event) => {
  if (messageContextMenu && !messageContextMenu.contains(event.target)) closeMessageContextMenu();
});

globalChatTab.addEventListener("click", () => setChatMode("global"));
privateChatTab.addEventListener("click", () => {
  setChatMode("private");
  if (!activeRoomCode) {
    showStartView();
  }
  renderRoomsDirectory();
});

homeLogo.addEventListener("click", () => {
  if (currentName) leaveChat();
});

privateMessageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await sendPrivateMessage();
});

privateMessageInput.addEventListener("input", autoResizePrivateTextarea);

privateMessageInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    await sendPrivateMessage();
  }
});

privateCloseButton.addEventListener("click", closeActiveRoom);

privateBackButton.addEventListener("click", () => {
  privateLayout.classList.remove("show-thread");
});

privateStartBack.addEventListener("click", () => {
  privateLayout.classList.remove("show-thread");
});

createRoomButton.addEventListener("click", createPrivateRoom);

newRoomButton.addEventListener("click", showStartView);

joinRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  joinRoomError.textContent = "";
  await joinPrivateRoom(roomCodeInput.value);
});

roomCodeInput.addEventListener("input", () => {
  joinRoomError.textContent = "";
  roomCodeInput.value = roomCodeInput.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, ROOM_CODE_LENGTH);
});

roomMembersButton.addEventListener("click", toggleRoomMembersPanel);

copyCodeButton?.addEventListener("click", async () => {
  const code = activeRoomCode;
  if (!code) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const helper = document.createElement("textarea");
      helper.value = code;
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    showToast(`Code ${code} copied.`);
  } catch (_) {
    showToast(`Room code: ${code}`);
  }
});

attachButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  handleFileSelection(file);
});

removeAttachmentButton.addEventListener("click", clearAttachment);

privateAttachButton.addEventListener("click", () => privateFileInput.click());

privateFileInput.addEventListener("change", () => {
  const file = privateFileInput.files && privateFileInput.files[0];
  handlePrivateFileSelection(file);
});

privateRemoveAttachmentButton.addEventListener("click", clearPrivateAttachment);

/*
 * Paste copied files/images straight into either composer. Text pastes fall
 * through untouched; only file payloads are intercepted.
 */
messageInput.addEventListener("paste", (event) => {
  const files = event.clipboardData?.files;
  if (files && files.length > 0) {
    event.preventDefault();
    handleFileSelection(files[0]);
  }
});

privateMessageInput.addEventListener("paste", (event) => {
  const files = event.clipboardData?.files;
  if (files && files.length > 0) {
    event.preventDefault();
    handlePrivateFileSelection(files[0]);
  }
});

/*
 * The functional (and visual) drop zone is the whole chat panel, not just
 * the composer strip — a user dragging a file onto "the chat" expects
 * dropping anywhere in it to work, not just a ~50px bar pinned to the
 * bottom. dragenter/dragleave use a relatedTarget containment check so
 * moving across child elements (message bubbles, etc.) doesn't flicker
 * the highlight on and off — a naive toggle fires dragleave every time the
 * pointer crosses into a child, even though it never left the zone.
 */
function isEditableTarget(node) {
  const el = node instanceof Element ? node : null;
  if (!el) return false;
  return Boolean(el.closest("input, textarea, [contenteditable=''], [contenteditable='true']"));
}

// Drops carry files OR text. A drag from the desktop is a file; a drag of
// selected text (from this page or another app) arrives as text/plain with
// an empty `files` list.
function dropHasFiles(dataTransfer) {
  if (!dataTransfer) return false;
  if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  // During dragover `files` is always empty — `types` is the only reliable
  // signal of what's coming.
  return Array.from(dataTransfer.types || []).includes("Files");
}

function insertTextIntoComposer(inputEl, text, resize) {
  const existing = inputEl.value;
  const needsSpace = existing && !/\s$/.test(existing);
  inputEl.value = existing + (needsSpace ? " " : "") + text;
  resize();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function setupDropZone(zone, formEl, inputEl, resize, onFile) {
  if (!zone || !formEl || !inputEl) return;

  const setActive = (active) => {
    zone.classList.toggle("drag-over", active);
    formEl.classList.toggle("drag-over", active);
  };

  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    setActive(true);
  });

  zone.addEventListener("dragover", (event) => {
    // Dropping text straight onto the composer is left entirely to the
    // browser: it places the caret where you aim and inserts there, which
    // is better than anything we'd reimplement.
    if (!dropHasFiles(event.dataTransfer) && isEditableTarget(event.target)) return;
    event.preventDefault();
    setActive(true);
  });

  zone.addEventListener("dragleave", (event) => {
    if (!zone.contains(event.relatedTarget)) {
      setActive(false);
    }
  });

  zone.addEventListener("drop", (event) => {
    setActive(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) {
      event.preventDefault();
      onFile(file);
      return;
    }

    // Let the native text insertion happen when aimed at the composer.
    if (isEditableTarget(event.target)) return;

    const text = event.dataTransfer?.getData("text/plain");
    if (!text) return;

    // Text dropped anywhere else in the panel still belongs in the
    // composer — append it rather than silently discarding the drop.
    event.preventDefault();
    insertTextIntoComposer(inputEl, text, resize);
  });
}

setupDropZone(
  globalChatPanel,
  messageForm,
  messageInput,
  autoResizeTextarea,
  handleFileSelection
);

setupDropZone(
  privateThreadSection,
  privateMessageForm,
  privateMessageInput,
  autoResizePrivateTextarea,
  (file) => {
    if (!privateRooms.get(activeRoomCode)) {
      showToast("Open a room first, then drop a file to attach it.");
      return;
    }
    handlePrivateFileSelection(file);
  }
);

// Safety net: dropping a FILE outside a recognized zone (header, sidebar,
// mode tabs) would otherwise navigate the whole tab to that file. Text
// drops and anything aimed at a text field are left alone so the browser's
// native drag-to-insert keeps working.
["dragover", "drop"].forEach((eventName) => {
  window.addEventListener(eventName, (event) => {
    if (isEditableTarget(event.target)) return;
    if (!dropHasFiles(event.dataTransfer)) return;
    event.preventDefault();
  });
});

window.addEventListener("online", () => {
  if (currentName && !isSubscribed) {
    subscribeToChat();
  }
});

/*
 * Watchdog: belt-and-braces for networks that kill sockets WITHOUT a clean
 * close event (DPI middleboxes). Every 5s we verify the socket truth; if it
 * died silently, we start reconnecting immediately instead of waiting for
 * the heartbeat machinery to notice.
 */
setInterval(() => {
  if (!currentName || !supabaseClient?.realtime) return;
  if (reconnectTimer) return; // A reconnect is already scheduled.

  const socketConnected = supabaseClient.realtime.isConnected();

  if (!socketConnected) {
    if (isSubscribed) {
      isSubscribed = false;
      setConnectionState("disconnected", "Reconnecting…");
    }
    if (!document.hidden && navigator.onLine) {
      scheduleReconnect();
    }
    return;
  }

  // Socket alive but the global channel never came back (races happen).
  if (!isSubscribed && !document.hidden) {
    subscribeToChat();
  }
}, WATCHDOG_INTERVAL_MS);

// Waking the device or switching WiFi networks: reconnect immediately.
document.addEventListener("visibilitychange", () => {
  if (!currentName) return;
  if (document.hidden) {
    // Tab may be discarded without a pagehide — flush now.
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    saveSession();
    return;
  }
  if (!supabaseClient?.realtime) return;
  if (!supabaseClient.realtime.isConnected() && !reconnectTimer) {
    subscribeToChat();
  }
});

window.addEventListener("offline", () => {
  if (currentName) {
    isSubscribed = false;
    setConnectionState("disconnected", "Disconnected");
  }
});

/*
 * On page refresh/close, browser memory is discarded and no history
 * is loaded when the page starts again. Realtime channel cleanup is
 * also attempted, although the server will eventually detect closure.
 */
window.addEventListener("pagehide", () => {
  // Flush the debounced session snapshot synchronously — a refresh that
  // lands inside the debounce window must not lose the newest messages.
  if (currentName) {
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer);
      sessionSaveTimer = null;
    }
    saveSession();
  }

  if (chatChannel && supabaseClient) {
    try {
      chatChannel.untrack();
      supabaseClient.removeChannel(chatChannel);
    } catch (_) {}
  }

  // Drop room channels; keys/history die with the page anyway.
  privateRooms.forEach((room) => {
    if (room.channel && supabaseClient) {
      try {
        supabaseClient.removeChannel(room.channel);
      } catch (_) {}
    }
  });
});

/*
 * Boot: if a previous session in THIS tab was saved and the current load is
 * a soft reload (probe served from HTTP cache), restore everything silently.
 * A hard refresh (cache bypassed) or a brand-new tab starts clean — and a
 * closed tab/browser never had state to begin with (sessionStorage died).
 */
(async function boot() {
  const saved = loadSavedSession();

  if (saved && isSoftReload()) {
    {
      const nav = performance.getEntriesByType("navigation")[0];
      console.info(
        "[globchat] soft reload detected — restoring session:",
        JSON.stringify({ type: nav && nav.type, transferSize: nav && nav.transferSize, encodedBodySize: nav && nav.encodedBodySize })
      );
    }
    const restored = await restoreSession(saved).catch((error) => {
      console.error("[globchat] session restore failed:", error);
      return false;
    });
    if (restored) {
      autoResizeTextarea();
      return;
    }
  }

  // Fresh session (first load, hard refresh, or unusable saved state).
  if (saved) {
    const nav = performance.getEntriesByType("navigation")[0];
    console.info(
      "[globchat] fresh boot despite saved state:",
      JSON.stringify({ type: nav && nav.type, transferSize: nav && nav.transferSize })
    );
  }
  clearSavedSession();
  autoResizeTextarea();
  nameInput.focus();
})();
