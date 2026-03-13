# Download Manager — Extension Chromium

Extension Chromium (Manifest V3) conçue pour s'intégrer nativement avec [Download Manager](https://github.com/Vayaris/Download-Manager), une application web auto-hébergée de gestion de téléchargements.

Elle permet d'envoyer des liens **magnet** et des fichiers **.torrent** directement depuis n'importe quel site vers votre instance Download Manager — d'un simple clic droit, sans quitter la page.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Première connexion](#première-connexion)
- [Utilisation](#utilisation)
- [Navigateurs compatibles](#navigateurs-compatibles)
- [Sécurité](#sécurité)
- [Structure du projet](#structure-du-projet)

---

## Fonctionnalités

- **Clic droit → Envoyer (dossier par défaut)** : envoi immédiat vers votre destination configurée
- **Clic droit → Envoyer… (choisir le dossier)** : ouvre un navigateur de dossiers qui liste l'arborescence réelle de votre serveur
- **Navigateur de dossiers intégré** dans le popup et dans la fenêtre de sélection — navigation via l'API `/api/files/browse` de votre serveur
- **Accès rapides** : chips cliquables pour chaque chemin autorisé configuré dans Download Manager
- **Création de dossier** à la volée depuis l'extension (`+ Nouveau dossier`)
- **Historique** des 5 derniers envois affichés dans le popup
- **Authentification complète** : login classique + support du **2FA (TOTP)** avec flow en deux étapes
- Aucune modification du backend requise

---

## Prérequis

- Une instance **[Download Manager](https://github.com/Vayaris/Download-Manager)** accessible depuis votre navigateur (réseau local ou VPN)
- Un navigateur basé sur **Chromium** (Chrome, Edge, Brave, Opera, Vivaldi…)
- Un compte utilisateur configuré sur votre Download Manager

---

## Installation

### 1. Récupérer les fichiers

Clonez ce dépôt ou téléchargez l'archive ZIP :

```bash
git clone https://github.com/Vayaris/Chromium-Extension-Download-Manager.git
```

Ou via le bouton **Code → Download ZIP** sur GitHub, puis décompressez.

### 2. Charger l'extension dans Chrome / Chromium

1. Ouvrez votre navigateur et allez à l'adresse :
   ```
   chrome://extensions
   ```

2. Activez le **Mode développeur** (interrupteur en haut à droite)

3. Cliquez sur **"Charger l'extension non empaquetée"**

4. Sélectionnez le dossier cloné/décompressé (celui qui contient `manifest.json`)

5. L'icône de l'extension apparaît dans la barre d'outils

> **Note :** Sur **Microsoft Edge**, rendez-vous sur `edge://extensions` et activez "Mode développeur". La procédure est identique.
> Sur **Brave**, allez sur `brave://extensions`.

---

## Première connexion

Cliquez sur l'icône de l'extension dans la barre d'outils pour ouvrir le popup.

### Sans 2FA

1. Renseignez l'**URL de votre serveur** Download Manager
   - Exemple : `http://192.168.1.100:40320`
   - Si exposé via un reverse proxy : `https://dm.mondomaine.com`
2. Entrez votre **identifiant** et votre **mot de passe**
3. Cliquez sur **"Se connecter"**

L'extension récupère automatiquement depuis votre serveur :
- Le **dossier de destination par défaut**
- La liste des **chemins autorisés** (affichés en accès rapides)

### Avec 2FA activé (TOTP)

L'extension gère le 2FA en deux étapes distinctes :

**Étape 1** — Renseignez l'URL du serveur, l'identifiant et le mot de passe → cliquez "Se connecter"

**Étape 2** — Un écran de vérification apparaît automatiquement :

```
┌──────────────────────────────────┐
│  🔒 Vérification en deux étapes  │
│                                  │
│  Entrez le code généré par votre │
│  application d'authentification. │
│                                  │
│  [ _ _ _ _ _ _ ]                 │
│                                  │
│  [     Valider     ]             │
│  ← Retour                        │
└──────────────────────────────────┘
```

- Entrez le code à 6 chiffres depuis **Google Authenticator**, **Authy** ou toute app TOTP compatible
- La soumission est **automatique** dès les 6 chiffres saisis
- En cas d'erreur, le champ se réinitialise automatiquement
- Le bouton **"← Retour"** permet de revenir à l'étape des identifiants

> Vos identifiants ne sont **jamais stockés en clair** dans l'extension. Seul le **token JWT** (durée de vie : 7 jours) est conservé dans `chrome.storage.local`, local à votre navigateur.

---

## Utilisation

### Changer la destination par défaut

Dans le popup (icône de l'extension) :

- Cliquez sur un **chip** (accès rapide) pour basculer immédiatement sur un chemin autorisé
- Cliquez sur **"Parcourir…"** pour ouvrir le navigateur de dossiers intégré et naviguer librement dans l'arborescence de votre serveur
- Le bouton **"+ Dossier"** crée un nouveau dossier à l'emplacement courant

### Envoyer un lien magnet

Sur n'importe quel site torrent, **faites un clic droit sur le lien magnet** et choisissez :

| Option | Comportement |
|--------|-------------|
| **Download Manager → Envoyer (dossier par défaut)** | Envoi immédiat vers la destination configurée dans le popup |
| **Download Manager → Envoyer… (choisir le dossier)** | Ouvre une fenêtre avec l'arborescence complète de votre serveur |

### Envoyer un fichier .torrent

Même procédure : **clic droit sur le lien `.torrent`** → même menu contextuel.

L'extension télécharge le fichier `.torrent` en mémoire puis le transmet directement à votre serveur via l'API — le fichier ne touche jamais votre disque local.

### Fenêtre de sélection du dossier

Quand vous choisissez **"Envoyer… (choisir le dossier)"**, une fenêtre s'ouvre :

```
┌─────────────────────────────────────────────┐
│ 📁 Choisir la destination                   │
│ [Magnet] magnet:?xt=urn:btih:...            │
├─────────────────────────────────────────────┤
│ /opt > download-manager > downloads         │  ← breadcrumb cliquable
├─────────────────────────────────────────────┤
│ 📁 films          ▶                         │
│ 📁 series         ▶                         │
│ 📁 musique        ▶                         │
├─────────────────────────────────────────────┤
│ Dossier sélectionné : /opt/.../downloads    │
│ [+ Nouveau dossier]  [Annuler]  [Envoyer ▶] │
└─────────────────────────────────────────────┘
```

- Naviguez en cliquant sur les dossiers ou les **breadcrumbs**
- Cliquez sur **"Envoyer"** pour confirmer — une animation de chargement s'affiche puis une confirmation de succès

---

## Navigateurs compatibles

| Navigateur | Support | Notes |
|-----------|---------|-------|
| **Google Chrome** | ✅ Complet | Recommandé |
| **Microsoft Edge** | ✅ Complet | `edge://extensions` |
| **Brave** | ✅ Complet | `brave://extensions` |
| **Opera / Opera GX** | ✅ Complet | Via menu Extensions |
| **Vivaldi** | ✅ Complet | Paramètres → Extensions |
| **Chromium** | ✅ Complet | `chrome://extensions` |
| **Firefox** | ❌ Non supporté | Firefox utilise Manifest V2 — non compatible |
| **Safari** | ❌ Non supporté | Nécessite une conversion Apple |

> L'extension utilise **Manifest V3**, standard actuel de Chromium. Elle est compatible avec toutes les versions de Chrome ≥ 88 (janvier 2021).

---

## Sécurité

### Ce que l'extension stocke localement

| Donnée | Emplacement | Durée |
|--------|-------------|-------|
| URL du serveur | `chrome.storage.local` | Permanent |
| Nom d'utilisateur | `chrome.storage.local` | Permanent |
| Token JWT | `chrome.storage.local` | Jusqu'à déconnexion ou expiration (7 jours) |
| Destination active | `chrome.storage.local` | Permanent |
| Chemins autorisés | `chrome.storage.local` | Mis à jour à chaque connexion |
| Historique des envois | `chrome.storage.local` | 10 dernières entrées |

**Votre mot de passe n'est jamais stocké.** Il est utilisé uniquement le temps de la requête de login, puis effacé de la mémoire.

En cas de 2FA, vos identifiants temporaires (utilisés pour la seconde étape) sont stockés **uniquement en mémoire vive** de la page popup et effacés immédiatement après la connexion ou si vous fermez le popup.

### Permissions demandées

```json
"permissions": ["contextMenus", "storage", "notifications", "windows"]
"host_permissions": ["http://*/*", "https://*/*"]
```

| Permission | Raison |
|-----------|--------|
| `contextMenus` | Ajouter les entrées dans le menu clic droit |
| `storage` | Stocker l'URL du serveur, le token et les préférences |
| `notifications` | Afficher les confirmations d'envoi |
| `windows` | Ouvrir la fenêtre de sélection de dossier |
| `host_permissions` *` | Communiquer avec votre serveur Download Manager sur son URL locale |

> `host_permissions: *` permet aux service workers MV3 de contacter votre serveur sans contrainte CORS côté navigateur. L'extension ne communique qu'avec l'URL que vous avez configurée.

### Aucune donnée ne quitte votre réseau

L'extension communique **exclusivement** avec l'URL que vous saisissez dans le popup. Aucune donnée n'est transmise à des serveurs tiers. Aucune télémétrie.

---

## Structure du projet

```
chrome-extension/
├── manifest.json            # Manifest V3 — déclaration de l'extension
├── background.js            # Service Worker — menus contextuels + appels API
├── lib/
│   └── api.js               # Client API partagé (référence)
├── popup/
│   ├── popup.html           # Interface principale (connexion, destination, historique)
│   ├── popup.js             # Logique : login 2 étapes, navigateur de dossiers, OTP
│   └── popup.css            # Styles (thème sombre cohérent avec Download Manager)
├── picker/
│   ├── picker.html          # Fenêtre de sélection de dossier
│   ├── picker.js            # Navigation arborescence + envoi vers l'API
│   └── picker.css           # Styles de la fenêtre picker
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Lien avec Download Manager

Cette extension est un satellite du projet [Download Manager](https://github.com/Vayaris/Download-Manager). Elle s'appuie sur les endpoints suivants de son API REST :

| Endpoint | Usage |
|----------|-------|
| `POST /api/auth/login` | Authentification (avec support OTP) |
| `GET /api/settings/` | Récupération de `default_destination` et `allowed_paths` |
| `GET /api/files/browse` | Navigation dans l'arborescence du serveur |
| `POST /api/files/mkdir` | Création de dossier |
| `POST /api/torrents/` | Envoi d'un lien magnet |
| `POST /api/torrents/upload` | Upload d'un fichier .torrent |

**Aucune modification du backend n'est nécessaire** pour utiliser cette extension.

---

## Licence

MIT — voir [LICENSE](LICENSE)
