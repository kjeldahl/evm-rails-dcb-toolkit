'use strict';

// Name conversions the checks share, mirroring the rules in
// .build-kit/CLAUDE.md ("Domain names follow the board"): event type strings
// are the board title in PascalCase with no spaces, Ruby identifiers are the
// snake_case of the same words, and a DCB tag key is the idAttribute field's
// name minus its Id suffix, snake_cased. Not a check itself.

// Lowercase, alphanumerics only — for tolerant equality between a board name
// and a directory/file name that was slugified or snake_cased from it.
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// "Customer registered" → ["Customer", "registered"]; "walletId" → ["wallet", "Id"];
// "HTTPRequest" → ["HTTP", "Request"]; "cart_item" → ["cart", "item"].
function words(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

// "Customer registered" → "CustomerRegistered"; "CustomerRegistered" → unchanged.
function pascalCase(s) {
  return words(s)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

// "walletId" → "wallet_id"; "Register Customer" → "register_customer".
function snakeCase(s) {
  return words(s)
    .map((w) => w.toLowerCase())
    .join('_');
}

// The tag key for an idAttribute field: "walletId" → "wallet", "league_id" →
// "league", "customerEmail" → "customer_email", "id" → "id" (nothing to strip).
function tagKey(fieldName) {
  const snake = snakeCase(fieldName);
  const stripped = snake.replace(/_?id$/, '');
  return stripped || snake;
}

module.exports = { normalize, words, pascalCase, snakeCase, tagKey };
