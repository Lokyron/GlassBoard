// Escaping for the HTML the server itself builds — today, the invitation mail.
// The dashboard escapes in the browser; this is the other side of the same
// rule, for text that reaches a mail client instead of a page.
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
