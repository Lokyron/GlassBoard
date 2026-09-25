# Glassboard

> **Architecture notes, in French.** English readers: the [README](../README.md)
> covers usage and installation, and [configuration-format.md](configuration-format.md)
> documents the configuration document.
>
> Documentation de reprise : la pile, l'arborescence, les commandes, les routes et les
> pièges connus. Le [`README`](../README.md) (en anglais) décrit l'installation et l'usage ;
> le format du fichier de configuration est dans
> [`configuration-format.md`](configuration-format.md).

## 1. Vue d'ensemble

- **Rôle & description** : tableau de bord auto-hébergé pour ses services : grille de raccourcis
  (avec dossiers), tuiles météo, suivi de moto GeoRide, recherche rapide. Tout s'édite directement
  sur la page, derrière une authentification en deux temps (mot de passe puis TOTP).
  La configuration vit côté serveur (un document JSON unique, 20 révisions conservées) et s'exporte
  ou se restaure en un fichier. Projet **open source (licence MIT)** pensé pour être publié :
  séparation stricte entre le logiciel et les données de l'utilisateur.
- **Cas d'usage** : page d'accueil du navigateur sur poste fixe et téléphone (PWA, vue mobile dédiée).
- **Statut du projet** : **Production**. Déploiement type : service systemd sur `127.0.0.1:3000`
  derrière un reverse proxy, ou conteneur Docker. Dépôt GitHub `Lokyron/GlassBoard`.

## 2. Stack technique & dépendances

- **Langage(s) & runtime** : JavaScript ESM, **Node.js ≥ 24** (utilise le module natif `node:sqlite`).
- **Frameworks & libs clés** : Express 5, `@node-rs/argon2` (hash argon2id), `otplib` 13 (TOTP),
  `qrcode` (enrôlement). Front **sans framework ni build** (HTML/CSS/JS vanilla) ; Leaflet vendorisé
  (`public/assets/vendor/`) pour la carte. i18n maison (7 langues : en, fr, es, de, it, pt, nl).
- **Base de données & stockage** : SQLite via `node:sqlite`, fichier `$DATA_DIR/glassboard.db`
  (configuration, compte, sessions, défis de connexion, révisions, cache, secrets chiffrés AES-256-GCM).
  `$DATA_DIR/backups/` (instantanés avant import), `$DATA_DIR/tiles/` (cache de tuiles OSM plafonné à 128 Mo).
- **Outils externes & APIs tierces** (tous appelés **côté serveur**, aucun jeton dans le navigateur) :
  - **Open-Meteo** (prévisions, géocodage) ;
  - **OpenStreetMap** (tuiles de carte, proxifiées et mises en cache) ;
  - **GeoRide API** (`api.georide.fr` : login, trackers, trajets, positions ; vitesses en nœuds).

## 3. Architecture & arborescence

```
Glassboard/
├── server/
│   ├── index.js            # Express : en-têtes de sécurité, session (attachUser), pages, routeurs, statiques
│   ├── env.js              # Lecture et validation des variables d'environnement
│   ├── db.js               # Ouverture SQLite (node:sqlite), schéma
│   ├── auth.js             # argon2id, sessions HttpOnly, défi de connexion 5 min, verrouillage
│   ├── crypto.js           # AES-256-GCM dérivé de APP_SECRET
│   ├── store.js            # Lecture / écriture de la config + révisions
│   ├── config-schema.js    # Validateur de la config (complète aussi les champs ajoutés = migration)
│   ├── default-config.js   # Configuration d'exemple neutre
│   ├── wallpaper.js        # Fond d'écran (contrôle des magic bytes, 4 Mo max)
│   ├── maintenance.js      # Tâche horaire : cache, sessions, tuiles, wal_checkpoint, ANALYZE
│   ├── routes/             # auth.js, config.js, integrations.js, appearance.js
│   └── integrations/       # weather.js, georide.js, map-tiles.js
├── public/                 # index.html, login.html, setup.html, assets/ (app.js, edit.js, i18n.js,
│                           #   themes.css, mobile.css, vendor/leaflet), manifest.webmanifest
├── scripts/                # config-export.mjs, config-import.mjs (CLI)
├── docs/                   # configuration-format.md, captures d'écran
├── Dockerfile              # node:24-bookworm-slim
└── docker-compose.yml      # service unique + volume glassboard-data
```

**Flux** : navigateur → Express (session obligatoire hors `/login` et `/setup`) → `store.js` / SQLite ;
les tuiles d'intégration appellent `/api/integrations/*`, qui interrogent les APIs tierces avec les
identifiants déchiffrés et mettent en cache. Premier démarrage : `/setup` crée le compte et enrôle le TOTP.

## 4. Prérequis & environnement

- Node.js ≥ 24 **ou** Docker + Compose.

| Variable | Description | Obligatoire | Valeur par défaut / Exemple |
|---|---|---|---|
| `APP_SECRET` | Signe les sessions et chiffre les secrets. Le perdre = sessions et identifiants perdus | **Oui** (prod) | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `PORT` | Port HTTP | Non | `3000` |
| `HOST` | Interface d'écoute | Non | `127.0.0.1` |
| `DATA_DIR` | Répertoire des données (hors arbre source) | Non | `./data` (Docker : `/data`) |
| `TRUST_PROXY` | `1` derrière un reverse proxy (IP réelles pour le verrouillage) | Non | `0` |
| `COOKIE_SECURE` | `auto` / `true` / `false` | Non | `auto` |
| `SESSION_TTL_HOURS` | Durée de session | Non | `720` |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | Verrouillage après échecs | Non | `5` / `15` |
| `OSM_CONTACT` | Contact envoyé aux services OpenStreetMap | Non | vide |

## 5. Guide d'installation & démarrage local

```bash
# 1. Dépendances
npm install
# 2. Environnement
cp .env.example .env        # renseigner APP_SECRET
# 3. Base : créée automatiquement dans DATA_DIR au premier lancement
# 4. Développement
npm run dev                 # http://127.0.0.1:3000 → /setup au premier accès
# 5. Production
npm start
```

**Docker** :
```bash
cp .env.example .env        # APP_SECRET requis
docker compose up -d --build     # http://localhost:8080
```

**Mise à jour d'une installation native** : remplacer l'arbre source (par exemple via `git archive`),
puis redémarrer le service. Les données vivent dans `DATA_DIR`, hors de l'arbre source : une mise à jour
ne les touche pas et aucune migration manuelle n'est nécessaire.

## 6. Scripts & commandes utiles

| Commande | Rôle |
|---|---|
| `npm start` / `npm run dev` | Lancement (dev avec `node --watch`) |
| `npm run config:export -- --out backup.json [--include-secrets]` | Export de la configuration (secrets exclus par défaut) |
| `npm run config:import -- backup.json` | Import (instantané automatique avant remplacement) |
| `docker compose exec glassboard node scripts/config-export.mjs --stdout > backup.json` | Export en Docker |

Pas de tests, linter ni CI configurés.

## 7. Endpoints & interfaces

- **Pages** : `/` (tableau de bord, session requise), `/login`, `/setup` (premier lancement).
- **API** (JSON, session requise sauf auth et santé) :

| Route | Rôle |
|---|---|
| `GET /api/health` | Santé + indicateur `setupRequired` |
| `/api/auth` | `GET /state`, `POST /setup`, `/totp/start`, `/totp/confirm`, `/login`, `/login/verify`, `/login/cancel`, `/logout`, `GET /me`, `POST /password`, `/recovery-codes` |
| `/api/config` | `GET/PUT /`, `GET /revisions`, `POST /revisions/:id/restore`, `GET /export`, `POST /import`, `POST /backup` |
| `/api/integrations` | `GET /weather/forecast`, `/weather/place`, `/georide/status|trackers|summary`, `POST /georide/login|logout`, `GET /map/tile/:z/:x/:y.png` |
| `/api/appearance` | `GET/PUT/DELETE /wallpaper`, `GET /wallpaper/info` |

- **Ports** : 3000 (natif), 8080 → 3000 (Docker).

## 8. Dette technique, TODOs & points d'attention

- **Aucun marqueur `TODO`/`FIXME`** dans le code.
- **`node:sqlite`** est encore marqué expérimental dans certaines versions de Node : épingler une version
  de Node 24 LTS dans le Dockerfile et sur le CT.
- **README modifié directement sur GitHub** (captures) : toujours faire `git fetch` avant de repartir du README local.
- **`document.startViewTransition`** : le callback est différé ; modifier l'état *avant* l'appel (piège déjà rencontré).
- **Fenêtre de dialogue unique** (`#dialog-modal`) : un éditeur imbriqué (un lien dans un dossier) doit
  rouvrir l'éditeur parent sur le même brouillon, jamais le fermer, sinon le brouillon est perdu.
- **Glisser-déposer « écran d'accueil »** (`makeArrangeable` dans `edit.js`, événements pointeur) :
  les grilles gardent leur élément d'un rendu à l'autre, donc les écouteurs sont posés **une seule fois**
  et relisent les options du dernier rendu (sinon ils s'empilent et un geste est traité plusieurs fois).
  La validation d'un dépôt ne doit pas attendre la fin d'une animation (elles se figent dans un onglet
  masqué) ; les transitions CSS de survol ne doivent pas être prises pour des cartes en mouvement.
- **PWA** : `public/sw.js` (réseau d'abord, jamais de cache pour `/api/` ni pour les pages, page
  `offline.html` en secours), `public/manifest.webmanifest`, icônes dans `public/icons/` (SVG sources,
  PNG rendus avec Chrome headless). Installation impossible sans HTTPS (hors `localhost`). Changer le
  contenu mis en cache ⇒ incrémenter `CACHE` dans `sw.js`.
- **Vue téléphone** : `.sidebar` et `.stack` passent en `display: contents` pour réordonner la page ;
  un élément sans boîte ne peut pas servir de cible à `scrollIntoView` (voir `goTo`).
- **Pas de tests automatisés** : prioriser le validateur de configuration (`config-schema.js`) et le flux d'authentification.
- `express.json({ limit: '16mb' })` global : large (motivé par l'import avec fond d'écran en base64) ;
  le restreindre aux routes d'import si possible.
