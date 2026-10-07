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
  (configurations, comptes, sessions, défis de connexion, invitations, révisions, cache, **trajets GeoRide
  du dernier mois**, secrets chiffrés AES-256-GCM). Fonds d'écran : un fichier `wallpaper-<id>.bin` par compte.
  `$DATA_DIR/backups/` (instantanés avant import), `$DATA_DIR/tiles/` (cache de tuiles OSM plafonné à 128 Mo).
- **Outils externes & APIs tierces** (tous appelés **côté serveur**, aucun jeton dans le navigateur) :
  - **Open-Meteo** (prévisions, géocodage) ;
  - **OpenStreetMap** (tuiles de carte, proxifiées et mises en cache) ;
  - **GeoRide API** (`api.georide.fr` : login, trackers, trajets, positions ; vitesses en nœuds).

## 3. Architecture & arborescence

Depuis la **2.0**, le cœur ne connaît aucune fonctionnalité par son nom : chaque fonctionnalité
est un **module** qui se déclare, et le cœur compose. Ajouter un module, c'est un dossier sous
`modules/` et une ligne dans `server/modules/registry.js` — rien d'autre ne change.

```
Glassboard/
├── server/                 # le cœur : il sait ce qu'est une configuration, une tuile,
│   │                       #   un compte ; il ne sait pas qu'il existe une météo.
│   ├── index.js            # Express : en-têtes, session (attachUser), pages, montage des modules
│   ├── env.js              # Lecture et validation des variables d'environnement
│   ├── db.js               # Ouverture SQLite (node:sqlite), schéma
│   ├── auth.js             # argon2id, sessions HttpOnly, défi de connexion 5 min, verrouillage
│   ├── crypto.js           # AES-256-GCM dérivé de APP_SECRET
│   ├── store.js            # Lecture / écriture de la config + révisions
│   ├── config-schema.js    # Validateur ; tuiles et intégrations composées depuis le registre
│   ├── default-config.js   # Configuration d'exemple neutre
│   ├── wallpaper.js        # Fond d'écran (contrôle des magic bytes, 4 Mo max)
│   ├── maintenance.js      # Tâche horaire : cache, sessions, tuiles, wal_checkpoint, ANALYZE
│   ├── update.js           # Canaux stable / bêta, fichier de requête lu par le service root
│   ├── smtp.js             # Client SMTP maison (RFC 5321), réglages d'instance dans `meta`
│   ├── release-notes.js    # Analyse de CHANGELOG.md pour la fenêtre « Nouveautés »
│   ├── modules/
│   │   ├── registry.js     # la liste des modules, et tout ce qu'il compose à partir d'elle
│   │   ├── workers.js      # pool de worker_threads : le travail lourd hors de la boucle
│   │   └── worker-host.js  # l'autre moitié, importée par un worker.js de module
│   ├── routes/             # auth.js, config.js, appearance.js, update.js, admin.js
│   └── integrations/       # weather.js, georide.js, parcels.js, mailbox.js, imap.js, map-tiles.js
├── modules/                # une fonctionnalité = un dossier (voir modules/README.md)
│   ├── weather/            # manifest.js, server.js, client/{tile,pane}.js
│   ├── georide/            # + jobs.js, worker.js, client/leaflet.js
│   ├── parcels/            # + jobs.js, worker.js
│   └── note/               # le plus petit : un manifeste et un rendu, rien d'autre
├── public/
│   ├── index.html          # charge /assets/main.js en <script type="module">
│   ├── assets/core/        # le noyau navigateur : dom, api, state, modals, theme,
│   │                       #   chrome, tiles (le registre client), forms, dialogs,
│   │                       #   shell, render, boot, kernel (ce qu'un module peut utiliser)
│   ├── assets/edit.js      # mode édition et réglages
│   ├── assets/i18n.js      # 7 langues (script classique, partagé avec les pages de connexion)
│   └── assets/vendor/      # Leaflet, chargé à la demande par le module georide
├── scripts/                # config-export.mjs, config-import.mjs, account.mjs, check-client.mjs
├── test/                   # node:test — config-schema, auth, modules, workers, bout en bout
└── docs/                   # configuration-format.md, captures d'écran
```

### Le contrat de module

```
modules/<id>/
  manifest.js      ce qu'il est : ses tuiles, la forme de ses réglages, son défaut d'activation
  server.js        facultatif — routes(router), monté sur /api/m/<id>
  jobs.js          facultatif — travail récurrent, hors du chemin des requêtes
  worker.js        facultatif — la moitié lourde, sur son propre thread
  client/tile.js   son rendu, servi sur /modules/<id>/tile.js
  client/pane.js   facultatif — son onglet dans les réglages
```

**La règle qui structure tout : une route n'appelle jamais le réseau.** Elle lit ce qu'un job a
écrit. C'est elle qui empêche une API tierce lente de retarder un tableau de bord — et, Node
servant toutes les requêtes sur un seul thread, de retarder ceux de tout le monde.

Seul `client/` est exposé en HTTP, sur `/modules/<id>/`. Le manifeste, les routes, les jobs et
le worker vivent dans le même dossier et ne sont joignables par personne (un test l'affirme,
traversée de chemin comprise).

### Un interrupteur par module, par compte

`config.modules.<id>.enabled`. Éteint veut dire éteint jusqu'en bas : pas de tuile, pas de route
(un garde devant le routeur répond `404 module_disabled`), pas de job, et le navigateur ne va
même pas chercher le code du module. **Ses tuiles restent dans la configuration** : rallumer rend
le tableau de bord tel qu'il était, sinon l'interrupteur serait un piège.

Une configuration écrite avant la 2.0 ne dit rien des modules : `validateModules` déduit l'état
de l'ancien `integrations.<id>.enabled` et de la présence d'une tuile du module, puis l'écrit dans
le document à la première sauvegarde. Rien à faire à la main.

**Flux** : navigateur → Express (session obligatoire hors `/login` et `/setup`) → `store.js` / SQLite.
Le navigateur charge `/assets/main.js`, qui importe le noyau, puis **importe dynamiquement** le
client des seuls modules dont une tuile est affichée. Les tuiles appellent `/api/m/<id>/*`, qui
lisent la base ; ce sont les jobs qui, eux, parlent aux APIs tierces, dans un worker.

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
| `npm test` | Le filet : `node:test` (82 tests) plus la vérification du graphe navigateur |
| `npm run check:client` | Analyse et lie tous les modules ES du navigateur avec le chargeur de Node |

`npm test` couvre le validateur de configuration, le flux d'authentification, le registre de
modules, le pool de workers et un bout en bout (setup, enrôlement, connexion en deux temps,
sauvegarde). `check:client` attrape un import qui ne résout plus ou un export disparu ; il
n'exécute rien, donc une référence à une variable locale supprimée reste invisible pour lui —
d'où l'habitude de charger la page pour de vrai après une refonte. Pas de linter ni de CI.

## 7. Endpoints & interfaces

Les routes d'un module vivent sous `/api/m/<id>` et sont montées par le registre, derrière
`requireAuth` et derrière le garde d'activation. Il n'y a plus de `/api/integrations`.

- **Pages** : `/` (tableau de bord, session requise), `/login`, `/setup` (premier lancement),
  `/approve` (approbation QR), `/invite` (acceptation d'une invitation, publique).
- **API** (JSON, session requise sauf auth et santé) :

| Route | Rôle |
|---|---|
| `GET /api/health` | Santé + indicateur `setupRequired` |
| `/api/auth` | `GET /invite` et `POST /invite` (publics), `GET /state`, `POST /setup`, `/totp/start`, `/totp/confirm`, `/login`, `/login/verify`, `/login/cancel`, `/logout`, `GET /me`, `POST /password`, `/recovery-codes` |
| `/api/config` | `GET/PUT /`, `GET /revisions`, `POST /revisions/:id/restore`, `GET /export`, `POST /import`, `POST /backup` |
| `/api/m/weather` | `GET /forecast`, `/place` |
| `/api/m/georide` | `GET /status\|trackers\|summary\|trips`, `POST /login\|logout`, `GET /map/tile/:z/:x/:y.png` |
| `/api/m/parcels` | `GET /`, `/status`, `/suggestions`, `POST /`, `/refresh`, `/import`, `/suggestions/:id/accept\|ignore`, `/mail/scan\|test`, `PUT/DELETE /key`, `/mail/password`, `DELETE /:id` |
| `/api/update` | `GET /` (version installée, tête du canal, état), `POST /channel`, `POST /start`, `GET /news`, `POST /news/seen` |
| `/api/admin` | **administrateur uniquement** : `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id`, `POST /accounts/:id/sign-out`, `DELETE /accounts/:id`, `POST /invitations`, `DELETE /invitations/:id`, `GET/PUT /smtp`, `POST /smtp/test` |
| `/api/appearance` | `GET/PUT/DELETE /wallpaper`, `GET /wallpaper/info` |

- **Ports** : 3000 (natif), 8080 → 3000 (Docker).

## 8. Dette technique, TODOs & points d'attention

- **Aucun marqueur `TODO`/`FIXME`** dans le code.
- **Animation des modales** (`openModal` / `closeModal` dans `app.js`, styles `.sheet.fly-*` dans
  `app-extra.css`) : la géométrie est mesurée en JS et transmise en variables CSS (`--ox`, `--oy`, `--os`) ;
  le timing et l'allure restent dans la feuille de style. **Toutes** les ouvertures et fermetures passent
  par ces deux fonctions — un `classList.remove('open')` direct couperait l'animation de sortie.
  `closeModal` renvoie une promesse : la carte GeoRide doit attendre sa résolution avant `destroyTripMap`,
  sinon le panneau se vide pendant qu'il est encore à l'écran. Garde-fou : un `setTimeout` double
  l'`animationend`, qui ne se déclenche jamais dans un onglet masqué. Sur téléphone, `mobile.css`
  réaffecte `.sheet.fly-in` à `sheetUp` : une feuille du bas monte, elle ne jaillit pas d'une carte — et
  il faut bien cibler `.sheet.fly-in`, car `.sheet` seul perd en spécificité quel que soit l'ordre des
  fichiers.
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
- **Trajets GeoRide : une table, pas un cache** (`georide_trips`, `server/integrations/georide.js`).
  Un mois de trajets, ce sont des dizaines de milliers de positions GPS — une douzaine de mégaoctets —
  et le redemander à chaque expiration de cache était la cause des ouvertures de carte interminables.
  Les trajets sont donc **stockés**, déjà amincis, et chaque synchronisation ne demande que ce qui suit
  le plus récent connu. Quatre points à ne pas défaire :
  - la fenêtre part du **début** du trajet le plus récent, pas de sa fin : un trajet encore en cours lors
    du dernier passage est stocké à moitié, et repartir de sa fin le laisserait tronqué pour toujours ;
  - sauf s'il est **terminé depuis plus de `SETTLED_MINUTES`** : ses positions ne sont alors plus
    demandées du tout, sinon une moto garée coûte un trajet entier de GPS toutes les cinq minutes ;
  - un trajet **déjà stocké qui revient sans positions** n'est pas réécrit (sa trace serait effacée) ;
  - **une seule synchronisation à la fois** par traceur (`syncing`), sinon la tuile et le mois, demandés
    au même instant à chaque chargement de page, rapatrient tous les deux le mois complet.
  `refreshMinutes` ne veut plus dire « durée de vie d'une réponse en cache » mais « fréquence d'appel
  à l'API » : la réponse, elle, est toujours sur le disque. `RETENTION_DAYS` vaut **31** et non 30, parce
  que c'est le maximum qu'accepte `integrations.georide.periodDays`.
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
- **Le travail lourd ne doit jamais revenir sur le thread principal.** C'était le défaut central
  avant la 2.0 : `syncTrips` analysait un mois de positions GPS et filtrait, par trajet, le tableau
  entier, pendant que plus aucune requête n'était servie — pour aucun compte. Tout cela vit
  maintenant dans `modules/georide/worker.js`, et le scan IMAP dans `modules/parcels/worker.js`.
  Un worker ouvre sa **propre** connexion SQLite ; c'est sûr parce que la base est en WAL.
- **`freshen` ne se fait plus attendre** : avec des trajets déjà en base, la synchronisation est
  *lancée sans être attendue* et le lecteur reçoit le mois qui est sur le disque. Seule la toute
  première synchronisation d'un traceur, quand il n'y a rien à servir, est attendue. Ne pas
  remettre un `await` là : c'est ce qui laissait la tuile vide jusqu'à quinze secondes.
- **Ordre des routes d'un module** : `'/:id'` ne correspond qu'à un segment, donc il masque toute
  route littérale d'un seul segment déclarée après lui. C'est arrivé : `DELETE /parcels/key`
  répondait « colis inconnu » et la clé 17TRACK restait en place. Les chemins littéraux d'abord.
- **URL d'un client de module** : le serveur sert `client/` sur `/modules/<id>/`, donc le dossier
  n'apparaît pas dans l'URL. Le registre importe `/modules/<id>/tile.js`. Un test l'affirme, parce
  que rien d'autre ne le dirait — un décalage ne se voit qu'en chargeant la page.
- ⚠️ **La feuille de style de Leaflet doit être insérée AVANT celles de l'application.**
  Elle était dans `index.html` avant `base.css` ; en la chargeant à la demande (2.0) elle se
  retrouvait **ajoutée après**, et comme `.leaflet-marker-icon{display:block}` et
  `.gr-pin{display:grid}` ont la même spécificité, c'est l'ordre qui tranche : la moto s'est
  décalée dans le coin de sa propre pastille et le fond de carte a perdu son thème.
  `modules/georide/client/leaflet.js` insère donc le `<link>` avant la première feuille existante.
  C'est le **troisième** avatar du même piège dans ce dépôt, après les media queries et les
  requêtes de conteneur : *à spécificité égale, le dernier gagne*.
- **`check:client` n'exécute rien** : il analyse et lie, donc il attrape un import cassé ou un
  export disparu, jamais une référence à une variable locale qu'un déplacement a laissée derrière.
  Après une refonte du navigateur, charger la page reste la seule vérification complète.
- **Un module éteint reste chargé en mémoire** s'il l'était avant qu'on l'éteigne : il n'y a pas
  de déchargement d'un module ES. D'où le contrôle de l'interrupteur dans `refreshModules`, sinon
  un module éteint continue d'interroger une route qui répond désormais 404.
- **Indices des tuiles en mode édition** : la grille n'affiche que les tuiles des modules allumés,
  mais les indices désignent `state.config.tiles` en entier. D'où `reorderSubset` : un glisser
  réordonne les positions visibles et laisse les autres exactement où elles sont.
