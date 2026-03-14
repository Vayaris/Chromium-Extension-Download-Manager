// ============================================================
// Download Manager Extension — Popup v2
// ============================================================

// ── DOM refs ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  // status
  statusDot:        $("statusDot"),
  statusText:       $("statusText"),
  openDMBtn:        $("openDMBtn"),
  // étape 1 — identifiants
  stepCredentials:  $("stepCredentials"),
  loginForm:        $("loginForm"),
  serverUrl:        $("serverUrl"),
  httpWarning:      $("httpWarning"),
  username:         $("username"),
  password:         $("password"),
  loginBtn:         $("loginBtn"),
  loginError:       $("loginError"),
  // étape 2 — OTP
  stepOtp:          $("stepOtp"),
  otpCode:          $("otpCode"),
  otpSubmitBtn:     $("otpSubmitBtn"),
  otpBackBtn:       $("otpBackBtn"),
  otpError:         $("otpError"),
  // connecté
  connectedPanel:   $("connectedPanel"),
  destPath:         $("destPath"),
  pickDestBtn:      $("pickDestBtn"),
  quickPathsSection:$("quickPathsSection"),
  quickPaths:       $("quickPaths"),
  browserSection:   $("browserSection"),
  closeBrowserBtn:  $("closeBrowserBtn"),
  breadcrumb:       $("breadcrumb"),
  folderList:       $("folderList"),
  browserError:     $("browserError"),
  mkdirBtn:         $("mkdirBtn"),
  confirmDestBtn:   $("confirmDestBtn"),
  historySection:   $("historySection"),
  historyList:      $("historyList"),
  loggedAs:         $("loggedAs"),
  logoutBtn:        $("logoutBtn"),
};

// ── State ─────────────────────────────────────────────────────
let state = {
  serverUrl: "",
  token: "",
  username: "",
  destination: "",
  allowedPaths: [],
  currentBrowsePath: "",
  // Stockage temporaire pendant le flow 2FA (jamais persisté)
  _pendingServerUrl: "",
  _pendingUsername: "",
  _pendingPassword: "",
};

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);

async function init() {
  const stored = await storage.get(["serverUrl", "token", "username", "destination", "allowedPaths"]);
  Object.assign(state, stored);

  if (stored.serverUrl) el.serverUrl.value = stored.serverUrl;
  if (stored.username)  el.username.value  = stored.username;

  // Alerte HTTP visible dès l'init si l'URL déjà stockée est HTTP non-locale
  updateHttpWarning(el.serverUrl.value);

  if (stored.token && stored.serverUrl) {
    await enterConnectedMode();
  } else {
    setStatus("off", "Non connecté");
    showStep("credentials");
  }
}

// ── Auto-save : serverUrl + username sauvegardés dès la saisie ─
// Cela garantit que les champs sont pré-remplis si l'utilisateur
// ferme le popup pour aller chercher ses identifiants (ex: Bitwarden).
let _saveTimer = null;
function scheduleFormSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const url  = el.serverUrl.value.trim().replace(/\/$/, "");
    const user = el.username.value.trim();
    if (url)  storage.set({ serverUrl: url });
    if (user) storage.set({ username: user });
  }, 400);
}
// Listeners rattachés après le chargement du DOM (el est déjà prêt)
el.serverUrl.addEventListener("input", () => {
  scheduleFormSave();
  updateHttpWarning(el.serverUrl.value);
});
el.username.addEventListener("input", scheduleFormSave);

function updateHttpWarning(val) {
  const isLocalhost = /localhost|127\.0\.0\.1/.test(val);
  el.httpWarning.style.display = (val.startsWith("http://") && !isLocalhost) ? "flex" : "none";
}

// ── Navigation entre les étapes ───────────────────────────────
function showStep(step) {
  el.stepCredentials.style.display = step === "credentials" ? "block" : "none";
  el.stepOtp.style.display         = step === "otp"         ? "block" : "none";
  el.connectedPanel.style.display  = step === "connected"   ? "block" : "none";
}

// ============================================================
// ÉTAPE 1 — IDENTIFIANTS
// ============================================================
el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError(el.loginError);

  const serverUrl = el.serverUrl.value.trim().replace(/\/$/, "");
  const username  = el.username.value.trim();
  const password  = el.password.value;

  if (!serverUrl) return showError(el.loginError, "L'URL du serveur est requise.");
  // Validation du protocole — rejette javascript:, data:, etc.
  try {
    const parsed = new URL(serverUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return showError(el.loginError, "L'URL doit commencer par http:// ou https://");
    }
  } catch {
    return showError(el.loginError, "URL invalide. Exemple : http://192.168.1.100:40320");
  }
  if (!username || !password) return showError(el.loginError, "Identifiants requis.");

  el.loginBtn.disabled = true;
  el.loginBtn.textContent = "Connexion…";

  try {
    const res  = await fetch(`${serverUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    // ── Cas 1 : OTP requis ────────────────────────────────
    if (data.otp_required === true && !data.otp_verified) {
      // On stocke les identifiants en mémoire uniquement (pas dans storage)
      state._pendingServerUrl = serverUrl;
      state._pendingUsername  = username;
      state._pendingPassword  = password;

      clearError(el.otpError);
      el.otpCode.value = "";
      el.otpSubmitBtn.disabled = true;
      showStep("otp");
      el.otpCode.focus();
      return;
    }

    // ── Cas 2 : Erreur (mauvais identifiants, IP bloquée…) ──
    if (!res.ok || !data.token) {
      throw new Error(data.detail || `Erreur ${res.status}`);
    }

    // ── Cas 3 : Connexion directe (pas de 2FA) ────────────
    await finalizeLogin(serverUrl, username, data.token);

  } catch (err) {
    showError(el.loginError, err.message);
  } finally {
    el.loginBtn.disabled = false;
    el.loginBtn.textContent = "Se connecter";
  }
});

// ============================================================
// ÉTAPE 2 — CODE OTP
// ============================================================

// Activation du bouton dès que 6 chiffres sont saisis
el.otpCode.addEventListener("input", () => {
  const val = el.otpCode.value.replace(/\D/g, "");
  el.otpCode.value = val; // force uniquement les chiffres
  el.otpSubmitBtn.disabled = val.length !== 6;
  // Auto-submit quand les 6 chiffres sont présents
  if (val.length === 6) submitOtp();
});

el.otpSubmitBtn.addEventListener("click", submitOtp);

el.otpBackBtn.addEventListener("click", () => {
  // Efface les identifiants temporaires et revient à l'étape 1
  state._pendingServerUrl = "";
  state._pendingUsername  = "";
  state._pendingPassword  = "";
  clearError(el.otpError);
  showStep("credentials");
  setStatus("off", "Non connecté");
});

async function submitOtp() {
  const otp = el.otpCode.value.trim();
  if (otp.length !== 6) return;

  clearError(el.otpError);
  el.otpSubmitBtn.disabled = true;
  el.otpSubmitBtn.textContent = "Vérification…";

  const { _pendingServerUrl, _pendingUsername, _pendingPassword } = state;

  try {
    const res = await fetch(`${_pendingServerUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: _pendingUsername,
        password: _pendingPassword,
        otp_code: otp
      })
    });
    const data = await res.json();

    if (!res.ok || !data.token) {
      throw new Error(data.detail || `Erreur ${res.status}`);
    }

    // Succès — on efface les identifiants temporaires
    state._pendingServerUrl = "";
    state._pendingUsername  = "";
    state._pendingPassword  = "";

    await finalizeLogin(_pendingServerUrl, _pendingUsername, data.token);

  } catch (err) {
    showError(el.otpError, err.message);
    el.otpCode.value = "";
    el.otpSubmitBtn.disabled = true;
    el.otpCode.focus();
  } finally {
    el.otpSubmitBtn.disabled = el.otpCode.value.length !== 6;
    el.otpSubmitBtn.textContent = "Valider";
  }
}

// ============================================================
// FINALISATION DE LA CONNEXION
// ============================================================
async function finalizeLogin(serverUrl, username, token) {
  state.serverUrl = serverUrl;
  state.token     = token;
  state.username  = username;
  await storage.set({ serverUrl, token, username });
  await enterConnectedMode();
}

// ============================================================
// MODE CONNECTÉ
// ============================================================
async function enterConnectedMode() {
  showStep("connected");
  el.loggedAs.textContent = state.username || "";
  setStatus("loading", "Chargement…");

  try {
    const res = await apiFetch("/api/settings/");
    const cfg = await res.json();

    state.allowedPaths = cfg.allowed_paths || [];
    await storage.set({ allowedPaths: state.allowedPaths });

    if (!state.destination && cfg.default_destination) {
      state.destination = cfg.default_destination;
      await storage.set({ destination: state.destination });
    }

    renderDestination(state.destination || cfg.default_destination || "—");
    renderQuickPaths(state.allowedPaths);
    setStatus("on", "Connecté");
  } catch (err) {
    if (err.status === 401) {
      await storage.set({ token: null });
      showStep("credentials");
      setStatus("off", "Session expirée — reconnectez-vous");
      return;
    }
    setStatus("warn", "Serveur inaccessible");
    renderDestination(state.destination || "—");
  }

  renderHistory();
}

// ── Destination display ───────────────────────────────────────
function renderDestination(path) {
  el.destPath.textContent = shortenPath(path);
  el.destPath.title = path;
  state.currentBrowsePath = path;
}

function shortenPath(p) {
  if (!p || p === "—") return "—";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return "/…/" + parts.slice(-2).join("/");
}

// ── Quick path chips ──────────────────────────────────────────
function renderQuickPaths(paths) {
  if (!paths || paths.length === 0) {
    el.quickPathsSection.style.display = "none";
    return;
  }
  el.quickPathsSection.style.display = "block";
  el.quickPaths.textContent = "";

  paths.forEach((p) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (p === state.destination ? " active" : "");
    chip.textContent = p.split("/").pop() || p;
    chip.title = p;
    chip.addEventListener("click", () => setDestination(p));
    el.quickPaths.appendChild(chip);
  });
}

async function setDestination(path) {
  state.destination = path;
  state.currentBrowsePath = path;
  await storage.set({ destination: path });
  renderDestination(path);
  renderQuickPaths(state.allowedPaths);
  el.browserSection.style.display = "none";
}

// ── Navigateur de dossiers inline ─────────────────────────────
el.pickDestBtn.addEventListener("click", () => {
  const isOpen = el.browserSection.style.display !== "none";
  if (isOpen) {
    el.browserSection.style.display = "none";
  } else {
    el.browserSection.style.display = "block";
    loadBrowser(state.destination || state.allowedPaths[0] || "/");
  }
});

el.closeBrowserBtn.addEventListener("click", () => {
  el.browserSection.style.display = "none";
});

el.confirmDestBtn.addEventListener("click", async () => {
  await setDestination(state.currentBrowsePath);
  el.browserSection.style.display = "none";
});

el.mkdirBtn.addEventListener("click", async () => {
  const name = prompt("Nom du nouveau dossier :");
  if (!name || !name.trim()) return;
  clearError(el.browserError);
  try {
    const res = await apiFetch("/api/files/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.currentBrowsePath, name: name.trim() })
    });
    const data = await res.json();
    await loadBrowser(data.path || state.currentBrowsePath);
  } catch (err) {
    showError(el.browserError, err.message);
  }
});

async function loadBrowser(path) {
  clearError(el.browserError);
  el.folderList.textContent = "";
  el.breadcrumb.textContent = "";

  const loadingEl = document.createElement("div");
  loadingEl.className = "loading";
  loadingEl.textContent = "Chargement…";
  el.folderList.appendChild(loadingEl);

  try {
    const res  = await apiFetch(`/api/files/browse?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    state.currentBrowsePath = data.path;

    // Breadcrumbs
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

    // Liste des dossiers
    el.folderList.textContent = "";
    const dirs = data.directories || [];
    if (dirs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Dossier vide";
      el.folderList.appendChild(empty);
    } else {
      dirs.forEach((dir) => {
        const row = makeFolderRow(dir);
        row.addEventListener("click", () => loadBrowser(dir.path));
        el.folderList.appendChild(row);
      });
    }

    el.confirmDestBtn.textContent = "Choisir ce dossier";

  } catch (err) {
    el.folderList.textContent = "";
    showError(el.browserError, err.message);
  }
}

// Crée un élément de ligne de dossier en pur DOM (pas d'innerHTML)
function makeFolderRow(dir) {
  const svgNS = "http://www.w3.org/2000/svg";
  const row = document.createElement("button");
  row.className = "folder-row";
  row.title = dir.path;

  const iconSvg = document.createElementNS(svgNS, "svg");
  iconSvg.setAttribute("viewBox", "0 0 20 20");
  iconSvg.setAttribute("fill", "none");
  iconSvg.setAttribute("stroke", "currentColor");
  iconSvg.setAttribute("stroke-width", "1.5");
  iconSvg.classList.add("fi");
  const iconPath = document.createElementNS(svgNS, "path");
  iconPath.setAttribute("d", "M2 6a2 2 0 012-2h3.586a1 1 0 01.707.293L9.5 5.5H16a2 2 0 012 2V15a2 2 0 01-2 2H4a2 2 0 01-2-2V6z");
  iconSvg.appendChild(iconPath);
  row.appendChild(iconSvg);

  const nameSpan = document.createElement("span");
  nameSpan.className = "folder-name";
  nameSpan.textContent = dir.name;
  row.appendChild(nameSpan);

  if (dir.has_children) {
    const chevSvg = document.createElementNS(svgNS, "svg");
    chevSvg.setAttribute("viewBox", "0 0 20 20");
    chevSvg.setAttribute("fill", "none");
    chevSvg.setAttribute("stroke", "currentColor");
    chevSvg.setAttribute("stroke-width", "1.8");
    chevSvg.classList.add("chevron");
    const chevPath = document.createElementNS(svgNS, "path");
    chevPath.setAttribute("d", "M7 5l5 5-5 5");
    chevSvg.appendChild(chevPath);
    row.appendChild(chevSvg);
  }

  return row;
}

// ── Historique ────────────────────────────────────────────────
async function renderHistory() {
  const { recentSends = [] } = await storage.get(["recentSends"]);
  if (recentSends.length === 0) {
    el.historySection.style.display = "none";
    return;
  }
  el.historySection.style.display = "block";
  el.historyList.textContent = "";

  recentSends.slice(0, 5).forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-row";

    const nameDiv = document.createElement("div");
    nameDiv.className = "h-name";
    nameDiv.textContent = item.name || "—";
    nameDiv.title = item.name || "";

    const destDiv = document.createElement("div");
    destDiv.className = "h-dest";
    destDiv.textContent = shortenPath(item.destination || "");
    destDiv.title = item.destination || "";

    row.appendChild(nameDiv);
    row.appendChild(destDiv);
    el.historyList.appendChild(row);
  });
}

// ── Boutons globaux ───────────────────────────────────────────
el.openDMBtn.addEventListener("click", () => {
  if (state.serverUrl) chrome.tabs.create({ url: state.serverUrl });
});

el.logoutBtn.addEventListener("click", async () => {
  await storage.set({ token: null });
  state.token = "";
  state._pendingServerUrl = "";
  state._pendingUsername  = "";
  state._pendingPassword  = "";
  el.password.value = "";
  showStep("credentials");
  setStatus("off", "Déconnecté");
});

// ── Status ────────────────────────────────────────────────────
function setStatus(type, text) {
  el.statusDot.className = `dot dot-${type}`;
  el.statusText.textContent = text;
}

// ── API fetch ─────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const { serverUrl, token } = await storage.get(["serverUrl", "token"]);
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${serverUrl}${path}`, { ...options, headers });
  if (res.status === 401) throw Object.assign(new Error("Session expirée"), { status: 401 });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try { detail = JSON.parse(text)?.detail || text; } catch {}
    throw new Error(detail || `Erreur ${res.status}`);
  }
  return res;
}

// ── Helpers ───────────────────────────────────────────────────
function showError(errEl, msg) {
  errEl.textContent = msg;
  errEl.style.display = "block";
}
function clearError(errEl) {
  errEl.textContent = "";
  errEl.style.display = "none";
}

const storage = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => {
    const toSet = {}, toRemove = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) toRemove.push(k);
      else toSet[k] = v;
    }
    return new Promise((r) => {
      const done = () => Object.keys(toSet).length ? chrome.storage.local.set(toSet, r) : r();
      toRemove.length ? chrome.storage.local.remove(toRemove, done) : done();
    });
  }
};
