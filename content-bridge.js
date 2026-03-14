// ============================================================
// Download Manager Extension — Content Script (ISOLATED world)
// ============================================================
// Pont de communication entre :
//   - content-main.js (MAIN world) — communique via window.postMessage
//   - background.js (service worker) — communique via chrome.runtime
//
// Ce script ne touche pas au DOM de la page, il ne fait que relayer.
// ============================================================

// ── MAIN world → Background ────────────────────────────────────
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  // Notification immédiate : un torrent va être envoyé
  // → le background active un flag pour annuler le download Chrome
  if (event.data?.type === "__dm_torrent_will_send") {
    chrome.runtime.sendMessage({ action: "torrent-will-send" });
  }

  // Torrent intercepté avec les données complètes
  if (event.data?.type === "__dm_torrent_intercepted") {
    chrome.runtime.sendMessage({
      action: "torrent-intercepted",
      data: event.data.data,
      filename: event.data.filename,
      url: event.data.url
    });
  }

  // Résultat d'un re-fetch demandé par le background
  if (event.data?.type === "__dm_refetch_result") {
    chrome.runtime.sendMessage({
      action: "refetch-result",
      id: event.data.id,
      success: event.data.success,
      data: event.data.data,
      filename: event.data.filename,
      error: event.data.error
    });
  }
});

// ── Background → MAIN world ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "do-refetch") {
    window.postMessage({
      type: "__dm_refetch",
      url: msg.url,
      id: msg.id
    }, "*");
  }
});
