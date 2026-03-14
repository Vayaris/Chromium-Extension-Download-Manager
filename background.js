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
// Le second paramètre `tab` contient l'id de l'onglet où l'utilisateur
// a fait le clic droit — on en a besoin pour injecter le fetch dans la page.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url   = info.linkUrl;
  const tabId = tab?.id ?? null;
  if (!url) return;

  // type est une indication initiale ; dispatch() affine si le lien est indirect
  const type = url.startsWith("magnet:") ? "magnet" : "torrent";

  if (info.menuItemId === "dm-send-default") {
    await handleSendDefault(type, url, tabId);
  } else if (info.menuItemId === "dm-send-pick") {
    await openPicker(type, url, tabId);
  }
});

// ── Send to default destination ───────────────────────────────
async function handleSendDefault(type, url, tabId) {
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

  await dispatch(type, url, destination || "", tabId);
}

// ── Open picker window ────────────────────────────────────────
async function openPicker(type, url, tabId) {
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
    `picker/picker.html?type=${encodeURIComponent(type)}&url=${encodeURIComponent(url)}&tabId=${encodeURIComponent(tabId ?? "")}`
  );

  chrome.windows.create({
    url: pickerUrl,
    type: "popup",
    width: 420,
    height: 560,
    focused: true
  });
}

// ── Message listener (from picker) ───────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "dm-send") {
    dispatch(msg.torrentType, msg.url, msg.destination, msg.tabId ?? null)
      .then((result) => sendResponse({ ok: true, name: result?.name }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async
  }
});

// ── Dispatch — détection du type à l'exécution ───────────────
async function dispatch(type, url, destination, tabId) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);
  let data;

  if (url.startsWith("magnet:")) {
    // ── Cas 1 : Lien magnet direct
    data = await sendMagnet(serverUrl, token, url, destination);
    const name = data.torrents?.[0]?.name || "Torrent";
    notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination);
    return { name };

  } else if (/\.torrent(\?|#|$)/i.test(url)) {
    // ── Cas 2 : URL dont le chemin se termine en .torrent (direct)
    data = await sendTorrentFile(serverUrl, token, url, destination);
    const name = data.torrents?.[0]?.name || extractFilename(url);
    notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination);
    return { name };

  } else {
    // ── Cas 3 : URL opaque / lien indirect
    // On injecte le fetch dans la page d'origine (tabId) pour qu'il
    // parte avec les cookies de session du site — sinon le serveur
    // répondrait avec une page de login au lieu du fichier torrent.
    data = await sendTorrentIndirect(serverUrl, token, url, destination, tabId);
    const name = data.torrents?.[0]?.name || "Torrent";
    notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination);
    return { name };
  }
}

// ── Lien torrent indirect ─────────────────────────────────────
// Stratégie :
//   1. Si on a un tabId valide → executeScript dans la page (avec cookies)
//   2. Sinon → fetch direct depuis le background (sans cookies, fallback)
async function sendTorrentIndirect(serverUrl, token, url, destination, tabId) {
  let ct, cd, finalUrl, blob;

  // ── Tentative 1 : fetch depuis le contexte de la page (avec cookies) ──
  if (tabId != null) {
    try {
      const result = await fetchFromPageContext(tabId, url);
      ct       = result.contentType;
      cd       = result.contentDisposition;
      finalUrl = result.finalUrl;

      // result.base64 → Blob
      const binary = atob(result.base64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes]);
    } catch (pageErr) {
      // L'onglet a peut-être été fermé — on tente en fallback
      console.warn("[DM] Fetch page échoué, fallback direct :", pageErr.message);
    }
  }

  // ── Tentative 2 : fetch direct depuis le background (sans cookies) ──
  if (!blob) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`Réponse HTTP ${res.status} pour ce lien`);
    ct       = (res.headers.get("content-type")        || "");
    cd       = (res.headers.get("content-disposition") || "");
    finalUrl = res.url;
    blob     = await res.blob();
  }

  ct = (ct || "").toLowerCase();
  cd = (cd || "").toLowerCase();

  const isTorrent =
    ct.includes("application/x-bittorrent") ||
    ct.includes("application/x-torrent")    ||
    /\.torrent(\?|#|$)/i.test(finalUrl)     ||
    /filename=["']?[^"']*\.torrent/i.test(cd);

  if (!isTorrent) {
    // Log détaillé pour debug — visible dans chrome://extensions → Service Worker → Console
    console.warn("[DM] Lien indirect non-torrent :", { ct, cd, finalUrl, blobSize: blob?.size });
    throw new Error(
      `Ce lien ne pointe pas vers un fichier .torrent` +
      (ct ? `\nType reçu : ${ct}` : "") +
      (finalUrl ? `\nURL finale : ${finalUrl}` : "")
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

// ── Injection du fetch dans la page (avec cookies de session) ─
// IMPORTANT : world: "MAIN" est indispensable.
//   - Sans world (= "ISOLATED") : le fetch part depuis l'origin de l'extension
//     (chrome-extension://...) → le site ne reçoit PAS ses cookies → il répond
//     avec la page HTML de login au lieu du fichier .torrent.
//   - Avec world: "MAIN" : le fetch s'exécute dans le vrai contexte JS de la
//     page → même origin, mêmes cookies, même Referer qu'un clic gauche normal.
async function fetchFromPageContext(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",   // ← CRITIQUE : exécution dans le contexte réel de la page
    func: async (fetchUrl) => {
      try {
        const res = await fetch(fetchUrl, {
          credentials: "include",
          redirect: "follow"
        });

        if (!res.ok) {
          return { error: `HTTP ${res.status} ${res.statusText}` };
        }

        const ct       = res.headers.get("content-type")        || "";
        const cd       = res.headers.get("content-disposition") || "";
        const finalUrl = res.url;

        const buf   = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);

        // Conversion en base64 par chunks pour ne pas exploser la call stack
        let binary = "";
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }

        return {
          ok: true,
          base64: btoa(binary),
          contentType: ct,
          contentDisposition: cd,
          finalUrl
        };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
    args: [url]
  });

  if (!results || !results[0]) {
    throw new Error("executeScript : aucun résultat (onglet fermé ?)");
  }

  // world:"MAIN" ne peuple pas results[0].error de la même façon —
  // on gère les erreurs via le champ .error retourné par la func
  const r = results[0].result;
  if (!r)       throw new Error("executeScript : résultat vide");
  if (r.error)  throw new Error(`Fetch page : ${r.error}`);
  if (!r.ok)    throw new Error("Fetch page : réponse inattendue");
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
  chrome.notifications.create({
    type: "basic",
    iconUrl: type === "success" ? "icons/icon48.png" : "icons/icon48.png",
    title,
    message
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
