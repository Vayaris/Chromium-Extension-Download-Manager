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
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    // Parent entry (for sub-menus on links)
    chrome.contextMenus.create({
      id: "dm-parent",
      title: "Download Manager",
      contexts: ["link"],
      targetUrlPatterns: ["magnet:*", "*://*/*.torrent", "*://*/*.torrent?*"]
    });

    chrome.contextMenus.create({
      id: "dm-send-default",
      parentId: "dm-parent",
      title: "Envoyer (dossier par défaut)",
      contexts: ["link"],
      targetUrlPatterns: ["magnet:*", "*://*/*.torrent", "*://*/*.torrent?*"]
    });

    chrome.contextMenus.create({
      id: "dm-send-pick",
      parentId: "dm-parent",
      title: "Envoyer… (choisir le dossier)",
      contexts: ["link"],
      targetUrlPatterns: ["magnet:*", "*://*/*.torrent", "*://*/*.torrent?*"]
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

// ── Context menu click handler ────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl;
  if (!url) return;

  const type = url.startsWith("magnet:") ? "magnet" : "torrent";

  if (info.menuItemId === "dm-send-default") {
    await handleSendDefault(type, url);
  } else if (info.menuItemId === "dm-send-pick") {
    await openPicker(type, url);
  }
});

// ── Send to default destination ───────────────────────────────
async function handleSendDefault(type, url) {
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

  await dispatch(type, url, destination || "");
}

// ── Open picker window ────────────────────────────────────────
async function openPicker(type, url) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);

  if (!serverUrl) {
    notify("error", "Download Manager non configuré", "Cliquez sur l'icône de l'extension pour le configurer.");
    return;
  }
  if (!token) {
    notify("error", "Non connecté", "Veuillez vous connecter depuis l'extension.");
    return;
  }

  const pickerUrl = chrome.runtime.getURL(
    `picker/picker.html?type=${encodeURIComponent(type)}&url=${encodeURIComponent(url)}`
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
    dispatch(msg.torrentType, msg.url, msg.destination)
      .then((result) => sendResponse({ ok: true, name: result?.name }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async
  }
});

// ── Dispatch (magnet or .torrent) ────────────────────────────
async function dispatch(type, url, destination) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);

  if (type === "magnet") {
    const data = await sendMagnet(serverUrl, token, url, destination);
    const name = data.torrents?.[0]?.name || "Torrent";
    notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination);
    return { name };
  } else {
    const data = await sendTorrentFile(serverUrl, token, url, destination);
    const name = data.torrents?.[0]?.name || extractFilename(url);
    notify("success", "Envoyé !", `"${name}" ajouté à Download Manager.`);
    await addToHistory(name, destination);
    return { name };
  }
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
