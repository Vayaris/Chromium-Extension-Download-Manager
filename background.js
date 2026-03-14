// ============================================================
// Download Manager Extension — Background Service Worker v2
// ============================================================
// NOTE: background.js cannot use ES module imports directly in
// Chrome MV3 service workers without "type":"module" in manifest.
// We inline the needed helpers here to keep the file self-contained.
// ============================================================

// ── Storage helpers ───────────────────────────────────────────
function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
  const toSet = {}, toRemove = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) toRemove.push(k);
    else toSet[k] = v;
  }
  return new Promise((resolve) => {
    const done = () => Object.keys(toSet).length ? chrome.storage.local.set(toSet, resolve) : resolve();
    toRemove.length ? chrome.storage.local.remove(toRemove, done) : done();
  });
}

// ── Context menus ─────────────────────────────────────────────
// targetUrlPatterns inclut *://*/* pour couvrir les liens "torrent indirect" :
// boutons dont l'URL opaque (ex: /download/12345) redirige vers un .torrent
// côté serveur via Content-Disposition. La détection du type est faite à
// l'exécution (runtime) dans dispatch().
const TORRENT_PATTERNS = ["magnet:*", "*://*/*.torrent", "*://*/*.torrent?*", "*://*/*"];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "dm-parent",
      title: "Download Manager",
      contexts: ["link"],
      targetUrlPatterns: TORRENT_PATTERNS
    });

    chrome.contextMenus.create({
      id: "dm-send-default",
      parentId: "dm-parent",
      title: "Envoyer (dossier par défaut)",
      contexts: ["link"],
      targetUrlPatterns: TORRENT_PATTERNS
    });

    chrome.contextMenus.create({
      id: "dm-send-pick",
      parentId: "dm-parent",
      title: "Envoyer… (choisir le dossier)",
      contexts: ["link"],
      targetUrlPatterns: TORRENT_PATTERNS
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

// ── Context menu click handler ────────────────────────────────
// On capture tab.id ET tab.url : le tabId sert pour executeScript,
// et pageUrl sert comme Referer + pour récupérer les cookies du domaine.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url     = info.linkUrl;
  const tabId   = tab?.id  ?? null;
  const pageUrl = tab?.url ?? "";
  if (!url) return;

  const type = url.startsWith("magnet:") ? "magnet" : "torrent";

  if (info.menuItemId === "dm-send-default") {
    await handleSendDefault(type, url, tabId, pageUrl);
  } else if (info.menuItemId === "dm-send-pick") {
    await openPicker(type, url, tabId, pageUrl);
  }
});

// ── Send to default destination ───────────────────────────────
async function handleSendDefault(type, url, tabId, pageUrl) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);

  if (!serverUrl) {
    notify("error", "Download Manager non configuré", "Cliquez sur l'icône de l'extension pour le configurer.");
    return;
  }
  if (!token) {
    notify("error", "Non connecté", "Veuillez vous connecter depuis l'extension.");
    return;
  }

  // Ensure we have a cached destination — fetch from server if not
  let { destination } = await getStorage(["destination"]);
  if (!destination) {
    try {
      const settings = await fetchSettings(serverUrl, token);
      destination = settings.default_destination;
      if (destination) await setStorage({ destination, allowedPaths: settings.allowed_paths });
    } catch {}
  }

  await dispatch(type, url, destination || "", tabId, pageUrl);
}

// ── Open picker window ────────────────────────────────────────
async function openPicker(type, url, tabId, pageUrl) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);

  if (!serverUrl) {
    notify("error", "Download Manager non configuré", "Cliquez sur l'icône de l'extension pour le configurer.");
    return;
  }
  if (!token) {
    notify("error", "Non connecté", "Veuillez vous connecter depuis l'extension.");
    return;
  }

  // On transmet le tabId dans l'URL du picker pour pouvoir injecter
  // le fetch dans la page d'origine lors de la validation du dossier
  const pickerUrl = chrome.runtime.getURL(
    `picker/picker.html?type=${encodeURIComponent(type)}&url=${encodeURIComponent(url)}&tabId=${encodeURIComponent(tabId ?? "")}&pageUrl=${encodeURIComponent(pageUrl)}`
  );

  chrome.windows.create({
    url: pickerUrl,
    type: "popup",
    width: 420,
    height: 560,
    focused: true
  });
}

// ── Flag anti-doublon pour l'interception ─────────────────────
// Quand le content script détecte un torrent, il envoie immédiatement
// "torrent-will-send" AVANT de lire les données. Ce flag est activé
// pour que onCreated sache qu'il doit juste annuler le download
// sans re-fetch (le content script s'en charge déjà).
let _contentScriptHandling = false;
let _contentScriptTimer = null;

// ── Pending refetch promises (for download interception) ──────
const _pendingRefetches = {};

// ── Message listener ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Picker demande d'envoyer un torrent
  if (msg.type === "dm-send") {
    dispatch(msg.torrentType, msg.url, msg.destination, msg.tabId ?? null, msg.pageUrl ?? "")
      .then((result) => sendResponse({ ok: true, name: result?.name }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Notification immédiate : le content script va envoyer un torrent
  if (msg.action === "torrent-will-send") {
    _contentScriptHandling = true;
    clearTimeout(_contentScriptTimer);
    // Reset après 30s au cas où le message "intercepted" n'arrive jamais
    _contentScriptTimer = setTimeout(() => { _contentScriptHandling = false; }, 30000);
  }

  // Content script (MAIN world) a intercepté un .torrent via fetch/XHR
  if (msg.action === "torrent-intercepted") {
    _contentScriptHandling = false;
    clearTimeout(_contentScriptTimer);
    handleInterceptedTorrent(msg, sender);
  }

  // Résultat d'un re-fetch demandé au content script
  if (msg.action === "refetch-result") {
    const cb = _pendingRefetches[msg.id];
    if (cb) {
      cb(msg);
      delete _pendingRefetches[msg.id];
    }
  }
});

// ── Traitement d'un torrent intercepté par le content script ──
async function handleInterceptedTorrent(msg, sender) {
  const { serverUrl, token, interceptDownloads } = await getStorage(["serverUrl", "token", "interceptDownloads"]);
  if (!serverUrl || !token || interceptDownloads === false) return;

  const { destination } = await getStorage(["destination"]);

  try {
    // Convertir base64 → blob
    const binary = atob(msg.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // Vérifier magic byte (torrent bencodé commence par 'd')
    if (bytes[0] !== 0x64) {
      console.log("[DM] Intercepté mais pas un torrent (premier octet:", bytes[0], ")");
      return;
    }

    const blob = new Blob([bytes], { type: "application/x-bittorrent" });
    const filename = msg.filename || "download.torrent";

    const formData = new FormData();
    formData.append("file", blob, filename);
    if (destination) formData.append("destination", destination);

    const headers = { "Authorization": `Bearer ${token}` };
    const res = await fetch(`${serverUrl}/api/torrents/upload`, {
      method: "POST", headers, body: formData
    });
    await checkRes(res);
    const data = await res.json();
    const name = data.torrents?.[0]?.name || filename;
    console.log("[DM] Torrent envoyé avec succès :", name);
    notify("success", "Torrent envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination || "");
  } catch (err) {
    console.error("[DM] Erreur upload torrent intercepté :", err);
    notify("error", "Erreur d'envoi", err.message || String(err));
  }
}

// ── Re-fetch via content script (dans le contexte de la page) ──
function refetchViaContentScript(tabId, url) {
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      delete _pendingRefetches[id];
      reject(new Error("Timeout re-fetch (15s)"));
    }, 15000);

    _pendingRefetches[id] = (result) => {
      clearTimeout(timeout);
      if (result.success) resolve(result);
      else reject(new Error(result.error || "Re-fetch échoué"));
    };

    chrome.tabs.sendMessage(tabId, { action: "do-refetch", url, id });
  });
}

// ── Dispatch — détection du type à l'exécution ───────────────
async function dispatch(type, url, destination, tabId, pageUrl) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);
  let data, name;

  if (url.startsWith("magnet:")) {
    data = await sendMagnet(serverUrl, token, url, destination);
    name = data.torrents?.[0]?.name || "Torrent";
  } else if (/\.torrent(\?|#|$)/i.test(url)) {
    data = await sendTorrentFile(serverUrl, token, url, destination);
    name = data.torrents?.[0]?.name || extractFilename(url);
  } else {
    data = await sendTorrentIndirect(serverUrl, token, url, destination, tabId, pageUrl);
    name = data.torrents?.[0]?.name || "Torrent";
  }

  notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
  await addToHistory(name, destination);
  return { name };
}

// ── Lien torrent indirect ─────────────────────────────────────
// 3 stratégies en cascade :
//   1. chrome.cookies → fetch depuis le background AVEC les cookies du site
//      (fonctionne toujours, indépendant du CSP et de l'état de l'onglet)
//   2. executeScript world:MAIN → fetch dans le contexte JS de la page
//      (fallback si cookies échoue, ex: site avec tokens dynamiques)
//   3. fetch direct sans cookies (dernier recours)
async function sendTorrentIndirect(serverUrl, token, url, destination, tabId, pageUrl) {
  let ct, cd, finalUrl, blob;
  const strategies = [];

  // ── Stratégie 1 : chrome.cookies (la plus fiable) ──────────
  try {
    console.log("[DM] Stratégie 1 : fetch avec chrome.cookies");
    const res = await fetchWithSiteCookies(url, pageUrl);
    ct       = (res.headers.get("content-type")        || "");
    cd       = (res.headers.get("content-disposition") || "");
    finalUrl = res.url;
    blob     = await res.blob();
    strategies.push("cookies:ok");
  } catch (e) {
    strategies.push("cookies:" + e.message);
    console.warn("[DM] Stratégie 1 (cookies) échouée :", e.message);
  }

  // Vérifier si c'est bien un torrent avant de passer au fallback
  if (blob) {
    const early = looksLikeTorrent(ct, cd, finalUrl, blob);
    const confirmed = early === true || (early === "maybe" && await confirmTorrentMagicBytes(blob));
    if (!confirmed) {
      console.warn("[DM] Cookies OK mais pas un torrent (ct=" + ct + ") — fallback");
      blob = null;
    }
  }

  // ── Stratégie 2 : executeScript world:MAIN (contexte page) ─
  if (!blob && tabId != null) {
    try {
      console.log("[DM] Stratégie 2 : executeScript world:MAIN");
      const result = await fetchFromPageContext(tabId, url);
      ct       = result.contentType;
      cd       = result.contentDisposition;
      finalUrl = result.finalUrl;
      const binary = atob(result.base64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes]);
      strategies.push("page:ok");
    } catch (e) {
      strategies.push("page:" + e.message);
      console.warn("[DM] Stratégie 2 (page) échouée :", e.message);
    }
  }

  // ── Stratégie 3 : fetch direct (dernier recours) ───────────
  if (!blob) {
    try {
      console.log("[DM] Stratégie 3 : fetch direct (sans cookies)");
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ct       = (res.headers.get("content-type")        || "");
      cd       = (res.headers.get("content-disposition") || "");
      finalUrl = res.url;
      blob     = await res.blob();
      strategies.push("direct:ok");
    } catch (e) {
      strategies.push("direct:" + e.message);
      console.error("[DM] Toutes les stratégies ont échoué :", strategies);
      throw new Error(`Impossible de récupérer le fichier.\nStratégies : ${strategies.join(" → ")}`);
    }
  }

  ct = (ct || "").toLowerCase();
  cd = (cd || "").toLowerCase();

  const detection = looksLikeTorrent(ct, cd, finalUrl, blob);
  // Si detection === "maybe" (Content-Type générique), vérifier les magic bytes
  const isTorrent = detection === true || (detection === "maybe" && await confirmTorrentMagicBytes(blob));

  if (!isTorrent) {
    console.warn("[DM] Pas un torrent :", { ct, cd, finalUrl, size: blob?.size, strategies });
    throw new Error(
      `Ce lien ne pointe pas vers un fichier .torrent` +
      (ct ? `\nType reçu : ${ct}` : "") +
      `\nStratégies tentées : ${strategies.join(" → ")}`
    );
  }

  const filename = extractFilenameFromHeaders(cd, finalUrl);
  const formData = new FormData();
  formData.append("file", blob, filename);
  if (destination) formData.append("destination", destination);

  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const uploadRes = await fetch(`${serverUrl}/api/torrents/upload`, {
    method: "POST", headers, body: formData
  });
  await checkRes(uploadRes);
  return uploadRes.json();
}

// ── Détection robuste : est-ce un fichier torrent ? ───────────
// Vérifie Content-Type, Content-Disposition, URL finale, ET les
// magic bytes (un fichier .torrent bencodé commence toujours par 'd').
function looksLikeTorrent(ct, cd, finalUrl, blob) {
  ct = (ct || "").toLowerCase();
  cd = (cd || "").toLowerCase();

  // Content-Type explicite
  if (ct.includes("application/x-bittorrent") || ct.includes("application/x-torrent")) return true;
  // URL finale contient .torrent
  if (/\.torrent(\?|#|$)/i.test(finalUrl)) return true;
  // Content-Disposition contient .torrent
  if (/filename=["']?[^"']*\.torrent/i.test(cd)) return true;

  // Magic bytes : un fichier torrent bencodé commence TOUJOURS par 'd'
  // On l'utilise quand le Content-Type est générique (octet-stream, force-download…)
  if (blob && blob.size > 0 && (
    ct.includes("octet-stream") || ct.includes("force-download") || ct === ""
  )) {
    // On ne peut pas lire le blob de façon synchrone ici, donc on vérifie
    // la taille : un fichier HTML de login fait >1KB et un torrent aussi,
    // mais un torrent a rarement >10MB et jamais 0 bytes.
    // La vérification réelle du premier octet se fait en async juste après.
    return "maybe"; // sera vérifié par le caller
  }

  return false;
}

// Vérifie les magic bytes de façon async
async function confirmTorrentMagicBytes(blob) {
  if (!blob || blob.size === 0) return false;
  const first = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
  return first[0] === 0x64; // 'd' en ASCII = début d'un dictionnaire bencodé
}

// ── Stratégie 1 : fetch avec les cookies extraits via chrome.cookies ─
// Avantages par rapport à executeScript :
//   - Pas bloqué par le CSP de la page
//   - Fonctionne même si l'onglet est fermé
//   - Accède aux cookies HttpOnly (invisibles au JS de la page)
async function fetchWithSiteCookies(url, pageUrl) {
  const cookies = await chrome.cookies.getAll({ url });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");

  if (!cookieHeader) {
    console.warn("[DM] Aucun cookie trouvé pour", url);
  } else {
    console.log("[DM] Cookies récupérés :", cookies.length, "cookies pour", new URL(url).hostname);
  }

  const headers = {};
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  if (pageUrl) headers["Referer"] = pageUrl;

  const res = await fetch(url, {
    redirect: "follow",
    credentials: "omit",   // on gère les cookies nous-mêmes
    headers
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// ── Stratégie 2 : injection dans le contexte de la page ──────
async function fetchFromPageContext(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (fetchUrl) => {
      try {
        const res = await fetch(fetchUrl, { credentials: "include", redirect: "follow" });
        if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };
        const ct       = res.headers.get("content-type")        || "";
        const cd       = res.headers.get("content-disposition") || "";
        const finalUrl = res.url;
        const buf      = await res.arrayBuffer();
        const bytes    = new Uint8Array(buf);
        let binary = "";
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { ok: true, base64: btoa(binary), contentType: ct, contentDisposition: cd, finalUrl };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
    args: [url]
  });

  if (!results?.[0]) throw new Error("executeScript : aucun résultat");
  const r = results[0].result;
  if (!r)      throw new Error("executeScript : résultat vide");
  if (r.error) throw new Error(`Fetch page : ${r.error}`);
  if (!r.ok)   throw new Error("Fetch page : réponse inattendue");
  return r;
}

// Extrait le nom de fichier depuis Content-Disposition en priorité,
// puis fallback sur l'URL finale.
function extractFilenameFromHeaders(contentDisposition, finalUrl) {
  // Supporte : filename="film.torrent" et filename*=UTF-8''film.torrent
  const match = contentDisposition.match(/filename\*?=["']?(?:utf-8'')?([^"';\s]+)/i);
  if (match && match[1]) {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }
  return extractFilename(finalUrl);
}

// ── API calls ─────────────────────────────────────────────────
async function sendMagnet(serverUrl, token, magnetUrl, destination) {
  const body = { magnets: [magnetUrl] };
  if (destination) body.destination = destination;
  const res = await authFetch(serverUrl, token, "/api/torrents/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendTorrentFile(serverUrl, token, fileUrl, destination) {
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`Impossible de récupérer le fichier .torrent (${fileRes.status})`);
  const blob = await fileRes.blob();
  const filename = extractFilename(fileUrl);

  const formData = new FormData();
  formData.append("file", blob, filename);
  if (destination) formData.append("destination", destination);

  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${serverUrl}/api/torrents/upload`, { method: "POST", headers, body: formData });
  await checkRes(res);
  return res.json();
}

async function fetchSettings(serverUrl, token) {
  const res = await authFetch(serverUrl, token, "/api/settings/");
  return res.json();
}

async function authFetch(serverUrl, token, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${serverUrl}${path}`, { ...options, headers });
  await checkRes(res);
  return res;
}

async function checkRes(res) {
  if (res.status === 401) {
    notify("error", "Session expirée", "Reconnectez-vous via l'extension.");
    throw Object.assign(new Error("Session expirée"), { status: 401 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try { detail = JSON.parse(text)?.detail || text; } catch {}
    notify("error", `Erreur ${res.status}`, detail);
    throw new Error(detail);
  }
}

// ── History helper ────────────────────────────────────────────
async function addToHistory(name, destination) {
  const { recentSends = [] } = await getStorage(["recentSends"]);
  recentSends.unshift({ name, destination, ts: Date.now() });
  if (recentSends.length > 10) recentSends.length = 10;
  await setStorage({ recentSends });
}

// ── Notification helper ───────────────────────────────────────
function notify(type, title, message) {
  const id = "dm-" + Date.now();
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: title || "Download Manager",
    message: message || "",
    priority: 2
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[DM] Notification échouée :", chrome.runtime.lastError.message);
    }
  });
}

// ── Utils ─────────────────────────────────────────────────────
function extractFilename(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/");
    return parts[parts.length - 1] || "upload.torrent";
  } catch {
    return "upload.torrent";
  }
}

// ── Interception des téléchargements .torrent ──────────────────
// Filet de sécurité : si le content script (MAIN world) n'a pas
// intercepté le fetch (ex: download déclenché par window.location),
// on l'attrape ici via chrome.downloads.onCreated et on re-fetch
// via le content script (qui a les cookies de la page).
chrome.downloads.onCreated.addListener(async (item) => {
  const mime = (item.mime || "").toLowerCase();
  const url  = item.finalUrl || item.url || "";

  // Détecter si c'est un fichier torrent
  const isTorrent =
    mime.includes("x-bittorrent") ||
    mime.includes("x-torrent") ||
    /\.torrent(\?|#|$)/i.test(url);

  if (!isTorrent) return;

  // Vérifier que l'extension est configurée et connectée
  const { serverUrl, token, interceptDownloads } = await getStorage(["serverUrl", "token", "interceptDownloads"]);
  if (!serverUrl || !token) return;
  if (interceptDownloads === false) return;

  // Le content script gère déjà ce torrent ? → juste annuler le download Chrome
  if (_contentScriptHandling || url.startsWith("blob:")) {
    console.log("[DM] Torrent déjà géré par content script, annulation du download...");
    try { await chrome.downloads.cancel(item.id); } catch {}
    try { await chrome.downloads.erase({ id: item.id }); } catch {}
    return;
  }

  // Annuler le téléchargement navigateur
  try { await chrome.downloads.cancel(item.id); } catch {}
  try { await chrome.downloads.erase({ id: item.id }); } catch {}

  const { destination } = await getStorage(["destination"]);

  // Trouver l'onglet actif pour re-fetch via content script
  let tabId = null;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
  } catch {}

  // ── Stratégie A : re-fetch via content script (page context + cookies) ──
  if (tabId) {
    try {
      console.log("[DM] Re-fetch via content script (tab", tabId, ")...");
      const result = await refetchViaContentScript(tabId, url);

      const binary = atob(result.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // Vérifier magic byte
      if (bytes[0] !== 0x64) throw new Error("Pas un fichier torrent (magic byte)");

      const blob = new Blob([bytes], { type: "application/x-bittorrent" });
      const filename = result.filename || "download.torrent";

      const formData = new FormData();
      formData.append("file", blob, filename);
      if (destination) formData.append("destination", destination);

      const headers = { "Authorization": `Bearer ${token}` };
      const uploadRes = await fetch(`${serverUrl}/api/torrents/upload`, {
        method: "POST", headers, body: formData
      });
      await checkRes(uploadRes);
      const data = await uploadRes.json();
      const name = data.torrents?.[0]?.name || filename;
      notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
      await addToHistory(name, destination || "");
      return;
    } catch (err) {
      console.warn("[DM] Re-fetch via content script échoué :", err.message);
    }
  }

  // ── Stratégie B : fetch direct avec chrome.cookies (fallback) ──
  try {
    console.log("[DM] Fallback: fetch avec chrome.cookies...");
    const res = await fetchWithSiteCookies(url, item.referrer || "");
    const blob = await res.blob();

    // Vérifier magic byte
    const first = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
    if (first[0] !== 0x64) throw new Error("Pas un fichier torrent");

    const cd = (res.headers.get("content-disposition") || "").toLowerCase();
    const filename = extractFilenameFromHeaders(cd, res.url || url);

    const formData = new FormData();
    formData.append("file", blob, filename);
    if (destination) formData.append("destination", destination);

    const headers = { "Authorization": `Bearer ${token}` };
    const uploadRes = await fetch(`${serverUrl}/api/torrents/upload`, {
      method: "POST", headers, body: formData
    });
    await checkRes(uploadRes);
    const data = await uploadRes.json();
    const name = data.torrents?.[0]?.name || filename;
    notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination || "");
  } catch (err) {
    notify("error", "Erreur d'interception", err.message);
  }
});
