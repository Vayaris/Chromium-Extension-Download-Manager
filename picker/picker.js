// ============================================================
// Download Manager Extension — Picker (Folder Browser Window)
// ============================================================

// ── State ─────────────────────────────────────────────────────
let state = {
  torrentType: "",   // "magnet" | "torrent"
  url: "",
  currentPath: "",
  selectedPath: "",
  serverUrl: "",
  token: "",
};

// ── DOM refs ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  torrentInfo:    $("torrentInfo"),
  breadcrumb:     $("breadcrumb"),
  folderList:     $("folderList"),
  errorMsg:       $("errorMsg"),
  selectedPath:   $("selectedPath"),
  mkdirBtn:       $("mkdirBtn"),
  sendBtn:        $("sendBtn"),
  cancelBtn:      $("cancelBtn"),
  cancelBtn2:     $("cancelBtn2"),
  overlay:        $("overlay"),
  resultOverlay:  $("resultOverlay"),
  resultIcon:     $("resultIcon"),
  resultMsg:      $("resultMsg"),
  closeResultBtn: $("closeResultBtn"),
};

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Parse query params
  const params = new URLSearchParams(location.search);
  state.torrentType = params.get("type") || "magnet";
  state.url = params.get("url") || "";

  // Load stored config
  const stored = await storage.get(["serverUrl", "token", "destination", "allowedPaths"]);
  state.serverUrl = stored.serverUrl || "";
  state.token = stored.token || "";

  // Show torrent info
  renderTorrentInfo();

  // Start browser at stored destination
  const startPath = stored.destination || (stored.allowedPaths && stored.allowedPaths[0]) || "/";
  await loadBrowser(startPath);
});

// ── Torrent info bar ──────────────────────────────────────────
function renderTorrentInfo() {
  el.torrentInfo.textContent = "";

  const badge = document.createElement("span");
  badge.className = "badge " + (state.torrentType === "magnet" ? "badge-magnet" : "badge-torrent");
  badge.textContent = state.torrentType === "magnet" ? "Magnet" : ".torrent";
  el.torrentInfo.appendChild(badge);

  const urlSpan = document.createElement("span");
  urlSpan.className = "torrent-url";
  urlSpan.textContent = state.url.length > 60 ? state.url.slice(0, 57) + "…" : state.url;
  urlSpan.title = state.url;
  el.torrentInfo.appendChild(urlSpan);
}

// ── File browser ──────────────────────────────────────────────
async function loadBrowser(path) {
  // Défense en profondeur : rejette les chemins contenant des traversals
  if (!path || path.includes("..")) return;
  clearError();
  el.folderList.textContent = "";

  const loadingEl = document.createElement("div");
  loadingEl.className = "loading";
  loadingEl.textContent = "Chargement…";
  el.folderList.appendChild(loadingEl);

  try {
    const res = await apiFetch(`/api/files/browse?path=${encodeURIComponent(path)}`);
    const data = await res.json();

    state.currentPath = data.path;
    state.selectedPath = data.path;
    el.selectedPath.textContent = data.path;
    el.sendBtn.disabled = false;

    // ── Breadcrumbs
    el.breadcrumb.textContent = "";
    const crumbs = data.breadcrumbs || [];
    crumbs.forEach((crumb, i) => {
      const span = document.createElement("span");
      span.className = "crumb";
      span.textContent = crumb.name || "/";
      span.addEventListener("click", () => loadBrowser(crumb.path));
      el.breadcrumb.appendChild(span);
      if (i < crumbs.length - 1) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = " › ";
        el.breadcrumb.appendChild(sep);
      }
    });

    // ── Folder list
    el.folderList.textContent = "";
    const dirs = data.directories || [];

    if (dirs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Aucun sous-dossier";
      el.folderList.appendChild(empty);
    } else {
      dirs.forEach((dir) => {
        const row = document.createElement("button");
        row.className = "folder-row";
        row.title = dir.path;

        const svgNS = "http://www.w3.org/2000/svg";

        // Folder icon
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        svg.classList.add("fi");
        const p1 = document.createElementNS(svgNS, "path");
        p1.setAttribute("d", "M2 6a2 2 0 012-2h3.586a1 1 0 01.707.293L9.5 5.5H16a2 2 0 012 2V15a2 2 0 01-2 2H4a2 2 0 01-2-2V6z");
        svg.appendChild(p1);
        row.appendChild(svg);

        // Name
        const nameSpan = document.createElement("span");
        nameSpan.className = "folder-name";
        nameSpan.textContent = dir.name;
        row.appendChild(nameSpan);

        // Chevron if has children
        if (dir.has_children) {
          const chev = document.createElementNS(svgNS, "svg");
          chev.setAttribute("viewBox", "0 0 20 20");
          chev.setAttribute("fill", "none");
          chev.setAttribute("stroke", "currentColor");
          chev.setAttribute("stroke-width", "1.8");
          chev.classList.add("chevron");
          const cp = document.createElementNS(svgNS, "path");
          cp.setAttribute("d", "M7 5l5 5-5 5");
          chev.appendChild(cp);
          row.appendChild(chev);
        }

        row.addEventListener("click", () => loadBrowser(dir.path));
        el.folderList.appendChild(row);
      });
    }
  } catch (err) {
    el.folderList.textContent = "";
    showError(err.message);
  }
}

// ── Send ──────────────────────────────────────────────────────
el.sendBtn.addEventListener("click", sendNow);

async function sendNow() {
  if (!state.selectedPath) return;

  el.overlay.style.display = "flex";
  el.sendBtn.disabled = true;

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "dm-send",
        torrentType: state.torrentType,
        url: state.url,
        destination: state.selectedPath
      }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response && response.ok) resolve(response);
        else reject(new Error(response?.error || "Erreur inconnue"));
      });
    });

    el.overlay.style.display = "none";
    showResult("success", `Envoyé avec succès${result.name ? " : " + result.name : ""}`);
  } catch (err) {
    el.overlay.style.display = "none";
    showResult("error", err.message);
  }
}

// ── Mkdir ─────────────────────────────────────────────────────
el.mkdirBtn.addEventListener("click", async () => {
  const name = prompt("Nom du nouveau dossier :");
  if (!name || !name.trim()) return;
  // Rejette les noms contenant des séparateurs ou traversals
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    showError("Nom de dossier invalide (caractères interdits : / \\ ..)");
    return;
  }
  clearError();
  try {
    const res = await apiFetch("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.currentPath, name: name.trim() })
    });
    const data = await res.json();
    await loadBrowser(data.path || state.currentPath);
  } catch (err) {
    showError(err.message);
  }
});

// ── Cancel ────────────────────────────────────────────────────
el.cancelBtn.addEventListener("click", () => window.close());
el.cancelBtn2.addEventListener("click", () => window.close());
el.closeResultBtn.addEventListener("click", () => window.close());

// ── Result overlay ────────────────────────────────────────────
function showResult(type, msg) {
  el.resultIcon.textContent = type === "success" ? "✓" : "✕";
  el.resultIcon.className = "result-icon result-" + type;
  el.resultMsg.textContent = msg;
  el.resultOverlay.style.display = "flex";
}

// ── Error helpers ─────────────────────────────────────────────
function showError(msg) {
  el.errorMsg.textContent = msg;
  el.errorMsg.style.display = "block";
}
function clearError() {
  el.errorMsg.textContent = "";
  el.errorMsg.style.display = "none";
}

// ── API fetch ─────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  const res = await fetch(`${state.serverUrl}${path}`, { ...options, headers });
  if (res.status === 401) throw Object.assign(new Error("Session expirée — reconnectez-vous via l'extension"), { status: 401 });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try { detail = JSON.parse(text)?.detail || text; } catch {}
    throw new Error(detail || `Erreur ${res.status}`);
  }
  return res;
}

// ── Storage ───────────────────────────────────────────────────
const storage = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r))
};
