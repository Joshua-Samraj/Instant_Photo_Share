require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Environment variables that are required for the API to do its job.
 * We fail fast in production so a broken deploy is obvious instead of
 * surfacing as a mysterious 500 on the first guest request.
 */
const required = [
    'MONGODB_URI',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'PINECONE_API_KEY',
    'PYTHON_API_URL'
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0 && isProduction) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

// A predictable fallback is fine for local development, but production must
// provide a real secret or every session would be forgeable.
if (!process.env.JWT_SECRET && isProduction) {
    throw new Error('JWT_SECRET must be set in production.');
}

function numberFromEnv(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction,
    port: numberFromEnv('PORT', 3000),

    mongoUri: process.env.MONGODB_URI || '',
    mongoDb: process.env.MONGODB_DB || 'snapsync_prod',

    cloudinary: {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
        apiKey: process.env.CLOUDINARY_API_KEY || '',
        apiSecret: process.env.CLOUDINARY_API_SECRET || ''
    },
    uploadFolder: process.env.CLOUDINARY_UPLOAD_FOLDER || 'snapsync_events',
    selfieFolder: process.env.CLOUDINARY_SELFIE_FOLDER || 'snapsync_selfies',

    pineconeApiKey: process.env.PINECONE_API_KEY || '',
    pineconeIndex: process.env.PINECONE_INDEX_NAME || 'snapsync',

    aiUrl: (process.env.PYTHON_API_URL || 'http://127.0.0.1:7860').replace(/\/+$/, ''),
    aiKey: process.env.PYTHON_API_KEY || '',
    aiTimeoutMs: numberFromEnv('PYTHON_API_TIMEOUT_MS', 50000),

    jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
    sessionCookie: process.env.SESSION_COOKIE_NAME || 'snapsync_session',
    sessionDays: numberFromEnv('SESSION_DAYS', 7),
    guestSessionHours: numberFromEnv('GUEST_SESSION_HOURS', 12),

    matchThreshold: numberFromEnv('MATCH_THRESHOLD', 0.55),
    matchTopK: numberFromEnv('MATCH_TOP_K', 60),

    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

    watermarkText: process.env.WATERMARK_TEXT || 'Natural Studio',
    previewWidth: numberFromEnv('PREVIEW_WIDTH', 1600),
    downloadWidth: numberFromEnv('DOWNLOAD_WIDTH', 2400),

    maxUploadFiles: numberFromEnv('MAX_UPLOAD_FILES', 10),
    maxUploadBytes: numberFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    maxSelfieBytes: numberFromEnv('MAX_SELFIE_BYTES', 8 * 1024 * 1024)
};

if (missing.length > 0 && !isProduction) {
    console.warn(`[config] Missing environment variables (dev mode): ${missing.join(', ')}`);
}

module.exports = config;
