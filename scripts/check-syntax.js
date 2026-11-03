const { execFileSync } = require('child_process');
const path = require('path');

const files = [
    'server.js',
    'api/index.js',
    'api/[...path].js',
    'src/app.js',
    'src/auth.js',
    'src/config.js',
    'src/db.js',
    'src/ai.js',
    'src/media.js',
    'src/pinecone.js',
    'public/assets/ui.js',
    'scripts/migrate-media.js'
];

let failed = false;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', path.join(__dirname, '..', file)], { stdio: 'pipe' });
        console.log(`ok   ${file}`);
    } catch (error) {
        failed = true;
        console.error(`FAIL ${file}`);
        console.error(String(error.stderr || error.message));
    }
}

if (failed) process.exit(1);
console.log('\nAll JavaScript files parse cleanly.');
