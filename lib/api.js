// ============================================================
// Download Manager Extension — Shared API Client
// Mirrors the pattern from frontend/static/js/api.js
// ============================================================

/**
 * Read a set of keys from chrome.storage.local.
 */
export function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

/**
 * Write key/value pairs to chrome.storage.local.
 * Passing null for a value will remove that key.
 */
export function setStorage(obj) {
  const toSet = {};
  const toRemove = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) toRemove.push(k);
    else toSet[k] = v;
  }
  return new Promise((resolve) => {
    const done = () => {
      if (Object.keys(toSet).length > 0) {
        chrome.storage.local.set(toSet, resolve);
      } else {
        resolve();
      }
    };
    if (toRemove.length > 0) chrome.storage.local.remove(toRemove, done);
    else done();
  });
}

// ── Core fetch helper ─────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);
  if (!serverUrl) throw new Error("Serveur non configuré");

  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
    delete options.json;
  }

  const res = await fetch(`${serverUrl}${path}`, { ...options, headers });
  if (res.status === 401) throw Object.assign(new Error("Session expirée"), { status: 401 });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try { detail = JSON.parse(text)?.detail || text; } catch {}
    throw Object.assign(new Error(detail || `Erreur ${res.status}`), { status: res.status });
  }
  return res;
}

// ── Auth ──────────────────────────────────────────────────────

export async function login(serverUrl, username, password, otpCode) {
  const body = { username, password };
  if (otpCode) body.otp_code = otpCode;
  const res = await fetch(`${serverUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.detail || `Erreur ${res.status}`), { status: res.status, data });
  return data; // { token, otp_required }
}

export async function checkAuth() {
  const res = await apiFetch("/api/auth/status");
  return res.json();
}

// ── Settings ──────────────────────────────────────────────────

export async function getSettings() {
  const res = await apiFetch("/api/settings/");
  return res.json();
  // Returns: { default_destination, allowed_paths, simultaneous_downloads, ... }
}

// ── File browser ──────────────────────────────────────────────

export async function browse(path) {
  const encoded = encodeURIComponent(path || "/");
  const res = await apiFetch(`/api/files/browse?path=${encoded}`);
  return res.json();
  // Returns: { path, parent, directories: [{name, path, has_children}], breadcrumbs }
}

export async function mkdir(parentPath, name) {
  const res = await apiFetch("/api/files/mkdir", {
    method: "POST",
    json: { path: parentPath, name }
  });
  return res.json(); // { status: "created", path }
}

// ── Torrents ──────────────────────────────────────────────────

export async function sendMagnet(magnetUrl, destination) {
  const body = { magnets: [magnetUrl] };
  if (destination) body.destination = destination;
  const res = await apiFetch("/api/torrents/", { method: "POST", json: body });
  return res.json(); // { added, torrents: [{id, name, ready}] }
}

export async function sendTorrentFile(fileUrl, destination) {
  // Step 1 — download the .torrent bytes
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`Impossible de télécharger le fichier .torrent (HTTP ${fileRes.status})`);
  const blob = await fileRes.blob();
  const filename = extractFilename(fileUrl);

  // Step 2 — upload as multipart/form-data
  const { serverUrl, token } = await getStorage(["serverUrl", "token"]);
  const formData = new FormData();
  formData.append("file", blob, filename);
  if (destination) formData.append("destination", destination);

  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${serverUrl}/api/torrents/upload`, {
    method: "POST",
    headers,
    body: formData
  });
  if (res.status === 401) throw Object.assign(new Error("Session expirée"), { status: 401 });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload échoué (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Utils ─────────────────────────────────────────────────────

export function extractFilename(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split("/");
    return parts[parts.length - 1] || "upload.torrent";
  } catch {
    return "upload.torrent";
  }
}

export function isMagnet(url) {
  return typeof url === "string" && url.startsWith("magnet:");
}

export function isTorrent(url) {
  return typeof url === "string" && (
    url.split("?")[0].endsWith(".torrent") ||
    url.includes(".torrent?")
  );
}
