/* Interface strings. English is the default; a locale is picked in the
   configuration (site.locale). Adding a language means adding one object. */
const I18N = {
  en: {
    'menu.edit': 'Edit dashboard', 'menu.settings': 'Settings', 'menu.export': 'Export configuration',
    'menu.import': 'Import configuration', 'menu.logout': 'Sign out',
    'edit.mode': 'Edit mode', 'edit.save': 'Save', 'edit.cancel': 'Cancel', 'edit.done': 'Leave edit mode',
    'edit.hint': 'Drag to reorder, use the grip to resize.',
    'edit.addTile': 'Add a tile', 'edit.addLink': 'Add a shortcut', 'edit.addFolder': 'Add a folder',
    'edit.addItem': 'Add a link', 'edit.remove': 'Remove', 'edit.settings': 'Tile settings',
    'edit.confirmRemove': 'Remove "{name}"?', 'edit.unsaved': 'You have unsaved changes.',
    'edit.saved': 'Dashboard saved.', 'edit.discarded': 'Changes discarded.',
    'side.search': 'Search', 'side.realtime': 'Real time', 'side.time': 'Time',
    'side.year': 'Year progress', 'side.day': 'Day',
    'nav.overview': 'Overview', 'nav.apps': 'Applications', 'nav.localWeather': 'Local weather',
    'greeting.morning': 'Good morning', 'greeting.evening': 'Good evening',
    'tile.localPosition': 'Local position', 'tile.searching': 'Locating…',
    'tile.followedCity': 'Followed city', 'tile.wind': 'Wind', 'tile.rain': 'Rain',
    'apps.title': 'Applications & folders', 'apps.shortcuts': '{n} shortcuts',
    'apps.direct': 'Direct access', 'apps.links': '{n} links',
    'wx.detailed': 'Detailed forecast', 'wx.today': 'Today', 'wx.gusts': 'Wind gusts',
    'wx.rain': 'Rain', 'wx.temperature': 'Temperature', 'wx.wind': 'Wind',
    'wx.unavailable': 'Weather unavailable',
    'gr.title': 'Motorcycle', 'gr.period': 'Last {n} days', 'gr.distance': 'Distance',
    'gr.time': 'Time', 'gr.trips': 'Trips', 'gr.topSpeed': 'Top',
    'gr.lastFix': 'Last fix', 'gr.moving': 'Moving', 'gr.parked': 'Parked',
    'gr.notConfigured': 'GeoRide is not configured. Open Settings to connect your account.',
    'gr.unavailable': 'GeoRide is unavailable right now.', 'gr.stale': 'Showing the last known data.',
    'gr.noPosition': 'No position available.', 'gr.openMap': 'Open in map',
    'note.heading': 'Note',
    'dlg.save': 'Save', 'dlg.cancel': 'Cancel', 'dlg.title': 'Title', 'dlg.url': 'URL',
    'dlg.colour': 'Colour', 'dlg.icon': 'Icon', 'dlg.name': 'Name',
    'set.title': 'Settings', 'set.general': 'General', 'set.weather': 'Weather', 'set.georide': 'GeoRide',
    'set.account': 'Account', 'set.data': 'Backup & restore',
    'set.siteTitle': 'Dashboard name', 'set.siteSubtitle': 'Subtitle', 'set.greeting': 'Greeting name',
    'set.locale': 'Language', 'set.sectionTitle': 'Shortcuts section title',
    'set.searchEnabled': 'Show the search box', 'set.searchAction': 'Search engine URL',
    'set.searchParam': 'Query parameter', 'set.clockLabel': 'Second clock label',
    'set.clockTz': 'Second clock time zone',
    'set.weatherEnabled': 'Enable the weather integration',
    'set.useGeo': 'Use the browser geolocation for the local tile',
    'set.reverse': 'Resolve the city name (OpenStreetMap)',
    'set.fallbackLat': 'Fallback latitude', 'set.fallbackLon': 'Fallback longitude',
    'set.refresh': 'Refresh every (minutes)',
    'set.georideEnabled': 'Enable the GeoRide integration',
    'set.georideEmail': 'GeoRide email', 'set.georidePassword': 'GeoRide password',
    'set.georideConnect': 'Connect', 'set.georideDisconnect': 'Disconnect',
    'set.georideConnected': 'Connected as {email}', 'set.georideTracker': 'Tracker',
    'set.georideMap': 'Show the map', 'set.periodDays': 'Statistics period (days)',
    'set.exportPlain': 'Export without secrets (recommended)',
    'set.exportSecrets': 'Export including secrets',
    'set.exportSecretsWarn': 'The file will contain your GeoRide credentials in plain text.',
    'set.import': 'Import a configuration file',
    'set.importSecrets': 'Also restore the secrets contained in the file',
    'set.importWarn': 'The current configuration is backed up on the server before importing.',
    'set.changePassword': 'Change password', 'set.currentPassword': 'Current password',
    'set.newPassword': 'New password', 'set.recoveryCodes': 'Recovery codes',
    'set.recoveryLeft': '{n} unused codes left', 'set.regenerate': 'Generate new codes',
    'set.signedInAs': 'Signed in as {name}',
    'msg.saved': 'Saved.', 'msg.error': 'Something went wrong.', 'msg.imported': 'Configuration imported.',
    'msg.copied': 'Copied.',
  },
  fr: {
    'menu.edit': 'Éditer le dashboard', 'menu.settings': 'Paramètres', 'menu.export': 'Exporter la configuration',
    'menu.import': 'Importer une configuration', 'menu.logout': 'Se déconnecter',
    'edit.mode': 'Mode édition', 'edit.save': 'Enregistrer', 'edit.cancel': 'Annuler', 'edit.done': 'Quitter l’édition',
    'edit.hint': 'Glisse pour réorganiser, utilise la poignée pour redimensionner.',
    'edit.addTile': 'Ajouter une tuile', 'edit.addLink': 'Ajouter un raccourci', 'edit.addFolder': 'Ajouter un dossier',
    'edit.addItem': 'Ajouter un lien', 'edit.remove': 'Supprimer', 'edit.settings': 'Réglages de la tuile',
    'edit.confirmRemove': 'Supprimer « {name} » ?', 'edit.unsaved': 'Des modifications ne sont pas enregistrées.',
    'edit.saved': 'Dashboard enregistré.', 'edit.discarded': 'Modifications annulées.',
    'side.search': 'Recherche', 'side.realtime': 'Temps réel', 'side.time': 'Heure',
    'side.year': 'Progression annuelle', 'side.day': 'Jour',
    'nav.overview': 'Vue générale', 'nav.apps': 'Applications', 'nav.localWeather': 'Météo locale',
    'greeting.morning': 'Bonjour', 'greeting.evening': 'Bonsoir',
    'tile.localPosition': 'Position locale', 'tile.searching': 'Recherche…',
    'tile.followedCity': 'Ville suivie', 'tile.wind': 'Vent', 'tile.rain': 'Pluie',
    'apps.title': 'Applications & dossiers', 'apps.shortcuts': '{n} raccourcis',
    'apps.direct': 'Accès direct', 'apps.links': '{n} liens',
    'wx.detailed': 'Prévisions détaillées', 'wx.today': 'Aujourd’hui', 'wx.gusts': 'Rafales vent',
    'wx.rain': 'Pluie', 'wx.temperature': 'Température', 'wx.wind': 'Vent',
    'wx.unavailable': 'Météo indisponible',
    'gr.title': 'Moto', 'gr.period': '{n} derniers jours', 'gr.distance': 'Distance',
    'gr.time': 'Temps', 'gr.trips': 'Trajets', 'gr.topSpeed': 'V. max',
    'gr.lastFix': 'Dernier point', 'gr.moving': 'En mouvement', 'gr.parked': 'À l’arrêt',
    'gr.notConfigured': 'GeoRide n’est pas configuré. Ouvre les paramètres pour connecter ton compte.',
    'gr.unavailable': 'GeoRide est indisponible pour le moment.', 'gr.stale': 'Affichage des dernières données connues.',
    'gr.noPosition': 'Aucune position disponible.', 'gr.openMap': 'Ouvrir la carte',
    'note.heading': 'Note',
    'dlg.save': 'Enregistrer', 'dlg.cancel': 'Annuler', 'dlg.title': 'Titre', 'dlg.url': 'URL',
    'dlg.colour': 'Couleur', 'dlg.icon': 'Icône', 'dlg.name': 'Nom',
    'set.title': 'Paramètres', 'set.general': 'Général', 'set.weather': 'Météo', 'set.georide': 'GeoRide',
    'set.account': 'Compte', 'set.data': 'Sauvegarde & restauration',
    'set.siteTitle': 'Nom du dashboard', 'set.siteSubtitle': 'Sous-titre', 'set.greeting': 'Prénom affiché',
    'set.locale': 'Langue', 'set.sectionTitle': 'Titre de la section raccourcis',
    'set.searchEnabled': 'Afficher le champ de recherche', 'set.searchAction': 'URL du moteur de recherche',
    'set.searchParam': 'Paramètre de requête', 'set.clockLabel': 'Libellé de la 2e horloge',
    'set.clockTz': 'Fuseau de la 2e horloge',
    'set.weatherEnabled': 'Activer l’intégration météo',
    'set.useGeo': 'Utiliser la géolocalisation du navigateur pour la tuile locale',
    'set.reverse': 'Résoudre le nom de la ville (OpenStreetMap)',
    'set.fallbackLat': 'Latitude de repli', 'set.fallbackLon': 'Longitude de repli',
    'set.refresh': 'Rafraîchir toutes les (minutes)',
    'set.georideEnabled': 'Activer l’intégration GeoRide',
    'set.georideEmail': 'E-mail GeoRide', 'set.georidePassword': 'Mot de passe GeoRide',
    'set.georideConnect': 'Connecter', 'set.georideDisconnect': 'Déconnecter',
    'set.georideConnected': 'Connecté en tant que {email}', 'set.georideTracker': 'Traceur',
    'set.georideMap': 'Afficher la carte', 'set.periodDays': 'Période des statistiques (jours)',
    'set.exportPlain': 'Exporter sans les secrets (recommandé)',
    'set.exportSecrets': 'Exporter en incluant les secrets',
    'set.exportSecretsWarn': 'Le fichier contiendra tes identifiants GeoRide en clair.',
    'set.import': 'Importer un fichier de configuration',
    'set.importSecrets': 'Restaurer aussi les secrets contenus dans le fichier',
    'set.importWarn': 'La configuration actuelle est sauvegardée sur le serveur avant l’import.',
    'set.changePassword': 'Changer de mot de passe', 'set.currentPassword': 'Mot de passe actuel',
    'set.newPassword': 'Nouveau mot de passe', 'set.recoveryCodes': 'Codes de récupération',
    'set.recoveryLeft': '{n} codes inutilisés restants', 'set.regenerate': 'Générer de nouveaux codes',
    'set.signedInAs': 'Connecté en tant que {name}',
    'msg.saved': 'Enregistré.', 'msg.error': 'Une erreur est survenue.', 'msg.imported': 'Configuration importée.',
    'msg.copied': 'Copié.',
  },
};

let currentLocale = 'en';

function setLocale(locale) {
  currentLocale = I18N[locale] ? locale : 'en';
  document.documentElement.setAttribute('lang', currentLocale);
}

/** Translate a key, replacing {placeholders} with the given values. */
function t(key, vars) {
  const table = I18N[currentLocale] || I18N.en;
  let value = table[key] ?? I18N.en[key] ?? key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, replacement);
    }
  }
  return value;
}

/** Fill every [data-t] element in the document with its translation. */
function applyTranslations(root = document) {
  root.querySelectorAll('[data-t]').forEach((el) => {
    el.textContent = t(el.dataset.t);
  });
}

const availableLocales = () => Object.keys(I18N);
