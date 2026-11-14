// contact.ts — the public addresses, in one place.
//
// All three forward to the same inbox; they exist so a reader writes to the
// right one. Keep the aliases in sync with the forwarding rules: mail@ is the
// general front door, support@ is for help with an account or the app, legal@
// is only for the privacy policy and terms.

export const MAIL_EMAIL = 'mail@sltp-app.com';
export const SUPPORT_EMAIL = 'support@sltp-app.com';
export const LEGAL_EMAIL = 'legal@sltp-app.com';
