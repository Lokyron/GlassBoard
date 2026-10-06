/* Parcels — deliveries followed through 17TRACK, and the mailbox scan that
   finds the tracking numbers without being told them. */
export default {
  id: 'parcels',
  label: 'Parcels',
  defaultEnabled: false,
  server: () => import('./server.js'),
  // Its own tab in the settings, served from client/pane.js.
  hasPane: true,
  jobs: () => import('./jobs.js'),
  hasWorker: true,

  tiles: {
    parcels: {
      label: 'Parcels — delivery tracking',
      singleton: true,
      settings: () => ({}),
    },
  },

  settings: (v, raw, path) => ({
    // One provider for now. A parcel with no usable tracking number is
    // followed manually instead, which is decided per parcel, not here.
    provider: '17track',
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 15, max: 1440, fallback: 180 }),
    hideDeliveredAfterDays: v.num(raw.hideDeliveredAfterDays, `${path}.hideDeliveredAfterDays`, { min: 0, max: 30, fallback: 3 }),
    maxOnTile: v.num(raw.maxOnTile, `${path}.maxOnTile`, { min: 1, max: 10, fallback: 4 }),
    // Reading a mailbox to find parcels. The password lives in the secrets
    // table, never here: this document is exported and restored.
    mail: {
      enabled: v.bool(raw.mail?.enabled, false),
      host: v.str(raw.mail?.host, `${path}.mail.host`, { max: 120, fallback: 'imap.gmail.com' }),
      port: v.num(raw.mail?.port, `${path}.mail.port`, { min: 1, max: 65535, fallback: 993 }),
      user: v.str(raw.mail?.user, `${path}.mail.user`, { max: 200, fallback: '' }),
      mailbox: v.str(raw.mail?.mailbox, `${path}.mail.mailbox`, { max: 120, fallback: 'INBOX' }),
      senders: v.str(raw.mail?.senders, `${path}.mail.senders`, { max: 1000, fallback: '' }),
      sinceDays: v.num(raw.mail?.sinceDays, `${path}.mail.sinceDays`, { min: 1, max: 60, fallback: 14 }),
      maxMessages: v.num(raw.mail?.maxMessages, `${path}.mail.maxMessages`, { min: 10, max: 500, fallback: 150 }),
      scanHours: v.num(raw.mail?.scanHours, `${path}.mail.scanHours`, { min: 1, max: 48, fallback: 6 }),
    },
  }),
};
