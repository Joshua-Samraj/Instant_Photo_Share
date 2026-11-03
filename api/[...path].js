// Vercel catch-all: routes every /api/* request through the shared Express app.
// Keeping a single file avoids duplicating backend logic the way the old
// server.js + api/index.js pair did.
module.exports = require('../src/app');
