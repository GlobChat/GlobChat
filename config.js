/*
 * GlobChat configuration.
 *
 * These values are PUBLIC BY DESIGN. This is Supabase's publishable/anon
 * frontend key — every browser sends it with every request and any visitor
 * can read it from devtools. It is NOT a secret.
 *
 * What must NEVER appear in this repo or any frontend bundle:
 *   - service_role key
 *   - sb_secret_... key
 *   - any server/admin credential
 *
 * Security on the Supabase side comes from Row Level Security (RLS)
 * policies, storage bucket policies, and Realtime channel authorization —
 * not from hiding these values. See README.md → "Keys & security".
 *
 * To rotate the key (e.g., after accidental exposure of a privileged key):
 *   1. Generate/rotate keys in Supabase Dashboard → Settings → API.
 *   2. Replace SUPABASE_KEY below with the new publishable/anon key.
 */
(function () {
  "use strict";

  var SUPABASE_URL = "https://igjzphucbcjumcagigyb.supabase.co";
  var SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnanpwaHVjYmNqdW1jYWdpZ3liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNzU2MTAsImV4cCI6MjEwMjk1MTYxMH0.To86dMzT6BQocX3EoLzof0SgPytYvU8DIP4ysx-obfg";

  // Basic sanity guard: refuse obvious misconfiguration early.
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL)) {
    console.warn("[globchat] SUPABASE_URL does not look like a project URL.");
  }

  try {
    var payload = JSON.parse(
      atob(SUPABASE_KEY.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    if (payload.role && payload.role !== "anon") {
      // A non-anon role here means someone pasted a privileged key.
      console.error(
        "[globchat] REFUSING TO RUN: configured key has elevated role '" +
          payload.role +
          "'. Use the publishable/anon key only."
      );
      return; // Do not expose anything to the app.
    }
  } catch (_) {
    console.warn("[globchat] Could not parse SUPABASE_KEY as a JWT publishable key.");
  }

  // Namespaced for script.js to pick up.
  window.GLOBCHAT_SUPABASE_URL = SUPABASE_URL;
  window.GLOBCHAT_SUPABASE_KEY = SUPABASE_KEY;
})();
