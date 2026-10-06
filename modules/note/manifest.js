/* A pinned note. No settings, no routes, no background work — which makes it
   the proof that the contract does not oblige a module to have any of them. */
export default {
  id: 'note',
  label: 'Note',

  tiles: {
    note: {
      label: 'Note',
      singleton: false,
      settings: (v, s, path) => ({
        heading: v.str(s.heading, `${path}.heading`, { max: 80, fallback: 'Note' }),
        body: v.str(s.body, `${path}.body`, { max: 2000, fallback: '' }),
      }),
    },
  },
};
