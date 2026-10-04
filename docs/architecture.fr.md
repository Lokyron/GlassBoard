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
- **Multi-comptes** : plusieurs comptes par instance, **chacun avec son propre tableau de bord**
  (configuration, révisions, fond d'écran, colis, suggestions, secrets d'intégration). Le **premier compte
  créé est l'administrateur** ; le rôle est délégable et repris, le dernier administrateur ne pouvant ni
  se retrograder ni être supprimé. Deux parcours d'entrée : création directe par l'administrateur, ou
  **lien d'invitation à usage unique** (48 h), envoyé par mail si un SMTP est configuré.
- **Base de données & stockage** : SQLite via `node:sqlite`, fichier `$DATA_DIR/glassboard.db`
  (configurations, comptes, sessions, défis de connexion, invitations, révisions, cache, secrets chiffrés
  AES-256-GCM). Fonds d'écran : un fichier `wallpaper-<id>.bin` par compte.
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
│   ├── update.js           # Canaux stable / bêta, fichier de requête lu par le service root
│   ├── smtp.js             # Client SMTP maison (RFC 5321), réglages d'instance dans `meta`
│   ├── release-notes.js    # Analyse de CHANGELOG.md pour la fenêtre « Nouveautés »
│   ├── mail-templates.js   # Le seul message envoyé : l'invitation
│   ├── html.js             # Échappement HTML côté serveur (pour le mail)
│   ├── routes/             # auth.js, config.js, integrations.js, appearance.js, update.js, admin.js
│   └── integrations/       # weather.js, georide.js, parcels.js, mailbox.js, imap.js, mime.js, map-tiles.js
├── public/                 # index.html, login.html, setup.html, assets/ (app.js, edit.js, i18n.js,
│                           #   themes.css, mobile.css, vendor/leaflet), manifest.webmanifest
├── scripts/                # config-export.mjs, config-import.mjs, account.mjs (CLI)
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

- **Pages** : `/` (tableau de bord, session requise), `/login`, `/setup` (premier lancement),
  `/approve` (approbation QR), `/invite` (acceptation d'une invitation, publique).
- **API** (JSON, session requise sauf auth et santé) :

| Route | Rôle |
|---|---|
| `GET /api/health` | Santé + indicateur `setupRequired` |
| `/api/auth` | `GET /invite` et `POST /invite` (publics), `GET /state`, `POST /setup`, `/totp/start`, `/totp/confirm`, `/login`, `/login/verify`, `/login/cancel`, `/logout`, `GET /me`, `POST /password`, `/recovery-codes` |
| `/api/config` | `GET/PUT /`, `GET /revisions`, `POST /revisions/:id/restore`, `GET /export`, `POST /import`, `POST /backup` |
| `/api/integrations` | `GET /weather/forecast` (horaire : température, ressenti, vent, code, jour/nuit ; quotidien : min/max, pluie, code, vent, **lever et coucher**), `/weather/place`, `/georide/status\|trackers\|summary\|trips`, `POST /georide/login\|logout`, `GET /parcels`, `/parcels/status`, `POST /parcels`, `/parcels/refresh`, `PATCH/DELETE /parcels/:id`, `PUT/DELETE /parcels/key`, `GET /parcels/suggestions`, `POST /parcels/suggestions/:id/accept\|ignore`, `POST /parcels/mail/scan\|test`, `PUT/DELETE /parcels/mail/password`, `GET /map/tile/:z/:x/:y.png` |
| `/api/update` | `GET /` (version installée, tête du canal, état), `POST /channel`, `POST /start`, `GET /news`, `POST /news/seen` |
| `/api/admin` | **administrateur uniquement** : `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id`, `POST /accounts/:id/sign-out`, `DELETE /accounts/:id`, `POST /invitations`, `DELETE /invitations/:id`, `GET/PUT /smtp`, `POST /smtp/test` |
| `/api/appearance` | `GET/PUT/DELETE /wallpaper`, `GET /wallpaper/info` |

- **Ports** : 3000 (natif), 8080 → 3000 (Docker).

## 8. Dette technique, TODOs & points d'attention

- **Aucun marqueur `TODO`/`FIXME`** dans le code.
- **Fenêtre « Nouveautés »** : le contenu vient de `CHANGELOG.md`, analysé au vol (`release-notes.js`),
  **jamais d'un second fichier** — deux listes des mêmes changements divergent, et c'est toujours celle que
  personne ne lit qui se périme. L'accusé de lecture est **par compte et côté serveur** (`meta`,
  `news.<id>.build`), indexé sur le **commit** et non sur la version : sur le canal bêta la version du
  `package.json` ne bouge pas d'un build à l'autre. Les notes restent **en anglais** (comme le README) ;
  seule l'interface autour est traduite, et elle le dit.
- **Cloisonnement des comptes** : toutes les routes lisent `req.user.id` et **jamais** un identifiant
  venu de la requête. C'est tout le cloisonnement : aucun paramètre ne désigne le tableau de bord, les
  colis ou les secrets de quelqu'un d'autre. Une révision appartenant à un autre compte répond `404` et
  non `403` — la réponse ne dit pas si l'identifiant existe.
- **Migration multi-comptes** (`migrateToAccounts` dans `db.js`) : SQLite **ne sait pas ajouter une colonne
  à une clé primaire**, donc `secrets` et `parcel_suggestions` (dont la clé s'élargit au compte) sont
  **reconstruites** — renommage, création, copie, suppression — dans une transaction unique avec
  `PRAGMA foreign_keys = OFF`, suivie d'un `PRAGMA foreign_key_check`. Pilotée par la **forme des tables**
  et non par un numéro de version : la relancer ne fait rien. Les index portant `user_id` sont créés
  **après** la migration, jamais dans le bloc de schéma initial (sinon `CREATE INDEX` échoue sur une table
  ancienne qui n'a pas encore la colonne — piège déjà rencontré).
- **Plus de seed au démarrage** : `getConfig()` était appelé dans `index.js` pour amorcer la configuration
  par défaut. Avec une configuration par compte, le serveur ne peut pas amorcer un compte qui n'existe pas
  encore : `getConfig(userId)` s'en charge à la première lecture.
- **Réglages SMTP dans `meta`, pas dans `secrets`** : ils appartiennent à l'instance et non à un compte,
  or `secrets` est devenu per-compte. Le mot de passe y est chiffré avec `APP_SECRET` comme ailleurs.
- **Scan des boîtes mail** : une boucle séquentielle sur les comptes, pas en parallèle — plusieurs
  connexions IMAP simultanées depuis une même adresse, c'est ce qu'un fournisseur lit comme un abus.
- **CLI** : `--user` obligatoire dès qu'il y a plusieurs comptes. Piège d'analyse d'arguments : la valeur
  de `--user` ne commence pas par un tiret, donc elle était prise pour le fichier à importer.
- **`node:sqlite`** est encore marqué expérimental dans certaines versions de Node : épingler une version
  de Node 24 LTS dans le Dockerfile et sur le CT.
- **README modifié directement sur GitHub** (captures) : toujours faire `git fetch` avant de repartir du README local.
- **`document.startViewTransition`** : le callback est différé ; modifier l'état *avant* l'appel (piège déjà rencontré).
- **Courbe du jour** (`renderDayCurve` dans `app.js`, styles `.wc-*` dans `app-extra.css`) : dessin **SVG
  et non canvas**, pour que les six presets et le clair/sombre pilotent les couleurs sans redessin. Le
  `viewBox` est **taillé sur la largeur réelle de la colonne** (`wcFit`), sinon le rapport d'aspect
  écraserait le dessin à ~95 px de haut dans une feuille de téléphone ; c'est la seule raison pour
  laquelle un redimensionnement de fenêtre doit redessiner. Les **arcs de nuit** ont une course qui
  enjambe minuit : il faut la *découper* à la fenêtre visible (`arcPath(rise, set, h, from, to)`) et non
  la *borner*, sinon la moitié de l'arc s'aplatit contre le bord gauche. Le passé est atténué par un
  `clipPath` sur les mêmes tracés, pas par un voile : un voile assombrirait aussi le fond d'écran.
- **Forme de la réponse Open-Meteo** : la clé de cache contient une version (`FORECAST_SHAPE` dans
  `weather.js`). **À incrémenter à chaque changement de `FORECAST_PARAMS`**, sinon une instance qui vient
  d'être mise à jour sert pendant `refreshMinutes` une charge utile dépourvue des nouveaux champs.
- **Date du jour** : `new Date().toISOString().slice(0,10)` donne le jour **UTC**. À l'est de Greenwich,
  en fin de soirée, ce n'est pas le bon jour. Utiliser `localDayKey()`.
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
- **Colis (17TRACK)** : un crédit est consommé à l'**enregistrement** d'un numéro, jamais à la lecture
  d'un statut. D'où la règle : on n'enregistre que sur action explicite de l'utilisateur, jamais sur une
  minuterie, et la lecture se fait en une requête groupée (40 numéros maximum par appel). Les colis
  vivent dans leur propre table, pas dans la configuration : ils vont et viennent chaque semaine et une
  révision de config par colis noierait l'historique réel du tableau de bord.
- **Colis Amazon Logistics** (numéro `TBA…`) : réseau fermé, aucun tiers ne peut les interroger, 17TRACK
  compris. D'où le suivi « à la main » (nom + lien vers la commande), sans statut automatique.
- **Canal de mise à jour** : le fichier de requête écrit par l'application contient un **nom de canal**,
  jamais un nom de branche. C'est le script root qui fait la correspondance, depuis son propre fichier
  unit, et tout ce qu'il ne reconnaît pas installe la branche stable. Sans cela, le côté non privilégié
  choisirait la référence à installer.
- **Ne jamais répondre `409`** depuis une route d'API appelée par le tableau de bord : `api()` dans
  `app.js` interprète ce code comme « instance à configurer » et quitte la page pour `/setup`.
- **Lecture de la boîte mail** (`imap.js`, client maison sans dépendance) : le piège central du protocole
  est le **littéral** (`{123}` en fin de ligne suivi de 123 octets bruts, CRLF compris) ; le lecteur est
  bâti autour. Boîte ouverte avec **`EXAMINE`** et non `SELECT`, lecture en **`BODY.PEEK`** : le serveur
  lui-même refuse toute écriture, la lecture seule ne repose pas sur ma discipline.
- **Piège accent + `\b`** : en expression régulière JavaScript, une lettre accentuée n'est pas un caractère
  de mot, donc `expédié\b` ne correspond jamais en fin de mot. Ce détail avait silencieusement désactivé
  toutes les phrases françaises de détection d'état.
- **Piège `href`** : retirer les balises HTML avec `/<[^>]+>/g` jette aussi les liens, or le numéro de suivi
  ne vit souvent que dans le `href`. Les liens sont extraits **avant** le décapage des balises.
- **`AggregateError`** : Node signale un refus de connexion en double pile par un `AggregateError` dont le
  `message` est vide ; il faut lire `.errors` sous peine d'afficher une erreur muette.
- **La suggestion n'est consommée qu'après création du colis** : la marquer acceptée avant l'appel au
  fournisseur la faisait disparaître à jamais quand le numéro était refusé (bug corrigé avant livraison).
- **Outlook / Microsoft 365 sont hors jeu en IMAP** depuis octobre 2024 : plus d'authentification par mot de
  passe, même d'application. Il faudrait OAuth2, et dans ce cas Microsoft Graph serait plus simple que
  IMAP+XOAUTH2. Gmail accepte toujours l'IMAP avec un mot de passe d'application (2FA obligatoire).
- **Pas de tests automatisés** : prioriser le validateur de configuration (`config-schema.js`) et le flux d'authentification.
- `express.json({ limit: '16mb' })` global : large (motivé par l'import avec fond d'écran en base64) ;
  le restreindre aux routes d'import si possible.
