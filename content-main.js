// ============================================================
// Download Manager Extension — Content Script (MAIN world)
// ============================================================
// Ce script s'exécute dans le contexte JavaScript de la page (world: MAIN).
// Déclaré dans manifest.json → n'est PAS bloqué par le CSP de la page.
//
// Rôle :
//   1. Intercepte les appels fetch()/XHR dont la réponse est un .torrent
//   2. Écoute les demandes de re-fetch venant de l'extension (via postMessage)
//   3. Communique avec content-bridge.js (ISOLATED world) via window.postMessage
// ============================================================

(function () {
  if (window.__dmInterceptorActive) return;
  window.__dmInterceptorActive = true;

  const TORRENT_MIMES = ["application/x-bittorrent", "application/x-torrent"];

  // Anti-doublon : un seul envoi par torrent détecté
  const _sent = new Set();

  // ── Override fetch() ──────────────────────────────────────────
  const _fetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await _fetch(...args);
    try { detectAndForward(response.clone()); } catch {}
    return response;
  };

  // ── Override XMLHttpRequest ───────────────────────────────────
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dmUrl = url;
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
        const cd = this.getResponseHeader("content-disposition") || "";
        if (isTorrentResponse(ct, cd, this.__dmUrl)) {
          const blob = this.response instanceof Blob
            ? this.response
            : new Blob([this.response]);
          handleTorrentBlob(blob, cd, this.responseURL || this.__dmUrl);
        }
      } catch {}
    });
    return _xhrSend.apply(this, args);
  };

  // ── Override URL.createObjectURL ──────────────────────────────
  const _createObjectURL = URL.createObjectURL.bind(URL);

  URL.createObjectURL = function (obj) {
    const blobUrl = _createObjectURL(obj);
    if (obj instanceof Blob && obj.size > 0 && obj.size < 50 * 1024 * 1024) {
      obj.slice(0, 1).arrayBuffer().then((buf) => {
        if (new Uint8Array(buf)[0] === 0x64) {
          handleTorrentBlob(obj, "", blobUrl);
        }
      }).catch(() => {});
    }
    return blobUrl;
  };

  // ── Détection d'une réponse torrent via fetch ─────────────────
  async function detectAndForward(response) {
    const ct = (response.headers.get("content-type") || "").toLowerCase();
    const cd = response.headers.get("content-disposition") || "";
    const url = response.url || "";

    if (!isTorrentResponse(ct, cd, url)) return;

    const blob = await response.blob();
    const first = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
    if (first[0] !== 0x64) return;

    handleTorrentBlob(blob, cd, url);
  }

  function isTorrentResponse(ct, cd, url) {
    ct = (ct || "").toLowerCase();
    cd = (cd || "").toLowerCase();
    if (TORRENT_MIMES.some((t) => ct.includes(t))) return true;
    if (/\.torrent/i.test(cd)) return true;
    if (/\.torrent(\?|#|$)/i.test(url || "")) return true;
    if (ct.includes("octet-stream") || ct.includes("force-download")) return true;
    return false;
  }

  // ── Traitement d'un blob torrent détecté ──────────────────────
  function handleTorrentBlob(blob, cd, url) {
    // Anti-doublon : ne pas envoyer deux fois (fetch + createObjectURL)
    // On utilise UNIQUEMENT la taille du blob comme clé car l'URL diffère
    // entre fetch (https://...) et createObjectURL (blob:https://...).
    // Deux torrents différents de la même taille exacte en <30s = quasi-impossible.
    const key = String(blob.size);
    if (_sent.has(key)) return;
    _sent.add(key);
    setTimeout(() => _sent.delete(key), 30000);

    // 1) Notification IMMÉDIATE au background pour qu'il sache
    //    qu'un download .torrent va/est en cours → il pourra annuler
    //    le chrome.downloads.onCreated sans doublon
    window.postMessage({ type: "__dm_torrent_will_send" }, "*");

    // 2) Lecture du blob et envoi des données
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      if (!base64) return;
      window.postMessage({
        type: "__dm_torrent_intercepted",
        data: base64,
        filename: extractFilename(cd, url),
        url: url
      }, "*");
    };
    reader.readAsDataURL(blob);
  }

  // ── Extraction du nom de fichier ──────────────────────────────
  function extractFilename(cd, url) {
    if (cd) {
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";\s]+)/i);
      if (m) {
        try { return decodeURIComponent(m[1].replace(/"/g, "")); } catch {}
        return m[1].replace(/"/g, "");
      }
    }
    try {
      const last = new URL(url).pathname.split("/").pop();
      if (last && /\.torrent/i.test(last)) return decodeURIComponent(last);
    } catch {}
    return "download.torrent";
  }

  // ── Re-fetch à la demande du background ───────────────────────
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "__dm_refetch") return;

    const { url, id } = event.data;
    try {
      const res = await _fetch(url, { credentials: "include", redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") || "";
      const reader = new FileReader();
      reader.onload = () => {
        window.postMessage({
          type: "__dm_refetch_result",
          id,
          success: true,
          data: reader.result.split(",")[1],
          filename: extractFilename(cd, res.url || url)
        }, "*");
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      window.postMessage({
        type: "__dm_refetch_result",
        id,
        success: false,
        error: err.message
      }, "*");
    }
  });
})();
