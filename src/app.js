const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { collections, pingDatabase } = require('./db');
const {
    hashPassword,
    verifyPassword,
    signPhotographerToken,
    signGuestToken,
    setSessionCookie,
    clearSessionCookie,
    requirePhotographer,
    requireGuest,
    createRateLimiter,
    publicPhotographer
} = require('./auth');
const {
    uploadPhoto,
    uploadSelfie,
    createPreviewAsset,
    destroyAsset,
    destroyPhotoAssets,
    buildSourceUrl,
    buildPreviewUrl,
    buildDownloadUrl,
    buildOwnerUrl
} = require('./media');
const { extractFaces, pickBestFace, aiHealth, AiServiceError } = require('./ai');
const { upsertFaces, deleteVectors, queryFaces, pineconeHealth } = require('./pinecone');

const app = express();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Express leaves req.body undefined when no parser matched (for example a
// POST without Content-Type). Normalise it so validation returns a clean 400
// instead of an accidental TypeError.
app.use((req, res, next) => {
    if (!req.body || typeof req.body !== 'object') req.body = {};
    next();
});

app.use(
    express.static(PUBLIC_DIR, {
        extensions: ['html'],
        maxAge: config.isProduction ? '1h' : 0,
        setHeaders(res, filePath) {
            // Pages must revalidate so a deploy is visible immediately.
            if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        }
    })
);

// Clean share links: /e/<eventId> and /dashboard both resolve to their page.
app.get('/e/:eventId', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'customer.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'photographer.html')));

const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: config.maxUploadFiles },
    fileFilter: imageFileFilter
});

const selfieUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxSelfieBytes, files: 1 },
    fileFilter: imageFileFilter
});

const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 25,
    message: 'Too many sign-in attempts. Please wait a few minutes.'
});
const guestLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'Too many requests from this device. Please wait a moment.'
});
const matchLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 30,
    message: 'Too many match requests. Please wait a moment.'
});

function imageFileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
        const error = new Error('Only image files are accepted.');
        error.status = 400;
        return callback(error);
    }
    return callback(null, true);
}

function asyncHandler(handler) {
    return function wrapped(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function run() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
    await Promise.all(runners);
    return results;
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

function normalizePhone(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function isValidPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 20;
}

function randomSuffix(length = 5) {
    return crypto.randomBytes(8).toString('hex').slice(0, length);
}

function requestBaseUrl(req) {
    if (config.publicBaseUrl) return config.publicBaseUrl;
    return `${req.protocol}://${req.get('host')}`;
}

function shareUrlFor(req, eventId) {
    return `${requestBaseUrl(req)}/e/${encodeURIComponent(eventId)}`;
}

function publicIdFromUrl(url) {
    const match = String(url || '').match(/\/image\/(?:upload|authenticated)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+)$/);
    if (!match) return null;
    return match[1].replace(/[?#].*$/, '').replace(/\.[a-zA-Z0-9]+$/, '');
}

function deliveryTypeFromUrl(url) {
    return /\/image\/authenticated\//.test(String(url || '')) ? 'authenticated' : 'upload';
}

function isCloudinaryUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com';
    } catch (error) {
        return false;
    }
}

async function findOwnedEvent(eventId, ownerId) {
    const { events } = await collections();
    return events.findOne({ eventId: String(eventId), ownerId: String(ownerId) });
}

async function findEvent(eventId) {
    const { events } = await collections();
    return events.findOne({ eventId: String(eventId) });
}

async function buildEventCounts(eventIds) {
    const ids = eventIds.map(String);
    if (ids.length === 0) return new Map();

    const { images, customers, matches } = await collections();
    const [photoRows, guestRows, matchRows] = await Promise.all([
        images
            .aggregate([{ $match: { eventId: { $in: ids } } }, { $group: { _id: '$eventId', count: { $sum: 1 } } }])
            .toArray(),
        customers
            .aggregate([{ $match: { eventId: { $in: ids } } }, { $group: { _id: '$eventId', count: { $sum: 1 } } }])
            .toArray(),
        matches
            .aggregate([{ $match: { eventId: { $in: ids } } }, { $group: { _id: '$eventId', count: { $sum: 1 } } }])
            .toArray()
    ]);

    const map = new Map(ids.map((id) => [id, { photoCount: 0, customerCount: 0, matchSearches: 0 }]));
    photoRows.forEach((row) => (map.get(row._id) || {}).photoCount = row.count);
    guestRows.forEach((row) => (map.get(row._id) || {}).customerCount = row.count);
    matchRows.forEach((row) => (map.get(row._id) || {}).matchSearches = row.count);
    return map;
}

function shapeEvent(req, event, counts = {}) {
    return {
        eventId: event.eventId,
        name: event.name,
        studioName: event.studioName,
        eventDate: event.eventDate || null,
        active: event.active !== false,
        createdAt: event.createdAt,
        photoCount: counts.photoCount || 0,
        customerCount: counts.customerCount || 0,
        matchSearches: counts.matchSearches || 0,
        shareUrl: shareUrlFor(req, event.eventId)
    };
}

function shapeOwnerPhoto(image) {
    const deliveryType = image.deliveryType || 'upload';
    return {
        imageId: image.imageId,
        url: buildOwnerUrl(image.publicId, null, deliveryType),
        thumbUrl: buildOwnerUrl(image.publicId, 900, deliveryType),
        width: image.width || null,
        height: image.height || null,
        bytes: image.bytes || null,
        facesCount: image.facesCount || 0,
        indexed: Boolean(image.indexed),
        indexError: image.indexError || null,
        uploadedAt: image.uploadedAt
    };
}

function shapeGuestPhoto(image, score, fallbackWatermark) {
    const watermark = image.studioName || fallbackWatermark || config.watermarkText;
    return {
        imageId: image.imageId,
        previewUrl: buildPreviewUrl(image, watermark),
        downloadUrl: buildDownloadUrl(image, watermark, `Natural_Studio_${image.imageId}`),
        width: image.width || null,
        height: image.height || null,
        score: Number(score.toFixed(3))
    };
}

/**
 * Old collections may not have a baked preview yet. Build it once, persist the
 * public ID, and fall back to the legacy transformed URL if Cloudinary is
 * temporarily unavailable.
 */
async function ensurePhotoPreview(image, watermark) {
    if (image.previewPublicId) return image;
    try {
        const preview = await createPreviewAsset(image.publicId, image.deliveryType || 'upload', watermark);
        const { images } = await collections();
        await images.updateOne(
            { imageId: image.imageId },
            { $set: { previewPublicId: preview.publicId, previewCreatedAt: new Date() } }
        );
        return { ...image, previewPublicId: preview.publicId };
    } catch (error) {
        console.error(`[cloudinary] Failed to create preview for ${image.imageId}:`, error.message);
        return image;
    }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', asyncHandler(async (req, res) => {
    const payload = {
        ok: true,
        service: 'snapsync-api',
        environment: config.nodeEnv,
        time: new Date().toISOString()
    };

    if (req.query.deep === '1') {
        const [mongo, pinecone, ai] = await Promise.all([
            pingDatabase().then(() => ({ ok: true })).catch((error) => ({ ok: false, error: error.message })),
            pineconeHealth(),
            aiHealth()
        ]);
        payload.services = { mongo, pinecone, ai };
        payload.ok = Boolean(mongo.ok && pinecone.ok && ai.ok);
        return res.status(payload.ok ? 200 : 503).json(payload);
    }

    return res.json(payload);
}));

/* ------------------------------------------------------------------ */
/* Photographer authentication                                         */
/* ------------------------------------------------------------------ */

app.post('/api/auth/register', authLimiter, asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const studioName = String(req.body.studioName || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your full name.' });
    if (studioName.length < 2 || studioName.length > 80) return res.status(400).json({ error: 'Enter your studio name.' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { photographers } = await collections();
    const existing = await photographers.findOne({ email });
    if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

    const doc = {
        name,
        studioName,
        email,
        passwordHash: await hashPassword(password),
        createdAt: new Date()
    };

    try {
        await photographers.insertOne(doc);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: 'An account with that email already exists.' });
        }
        throw error;
    }

    setSessionCookie(res, signPhotographerToken(doc));
    return res.status(201).json({ success: true, photographer: publicPhotographer(doc) });
}));

app.post('/api/auth/login', authLimiter, asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!isValidEmail(email) || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { photographers } = await collections();
    const photographer = await photographers.findOne({ email });
    const valid = photographer && (await verifyPassword(password, photographer.passwordHash));
    if (!valid) return res.status(401).json({ error: 'Incorrect email or password.' });

    setSessionCookie(res, signPhotographerToken(photographer));
    return res.json({ success: true, photographer: publicPhotographer(photographer) });
}));

app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    return res.json({ success: true });
});

app.get('/api/auth/me', requirePhotographer, asyncHandler(async (req, res) => {
    const { photographers } = await collections();
    const photographer = await photographers.findOne({ _id: safeObjectId(req.photographer.id) });
    if (!photographer) {
        clearSessionCookie(res);
        return res.status(401).json({ error: 'Account no longer exists.', code: 'UNAUTHENTICATED' });
    }
    return res.json({ success: true, photographer: publicPhotographer(photographer) });
}));

app.patch('/api/auth/profile', requirePhotographer, asyncHandler(async (req, res) => {
    const updates = {};
    if (req.body.name != null) {
        const name = String(req.body.name).trim();
        if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your full name.' });
        updates.name = name;
    }
    if (req.body.studioName != null) {
        const studioName = String(req.body.studioName).trim();
        if (studioName.length < 2 || studioName.length > 80) return res.status(400).json({ error: 'Enter your studio name.' });
        updates.studioName = studioName;
    }
    if (req.body.password) {
        if (String(req.body.password).length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        updates.passwordHash = await hashPassword(String(req.body.password));
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { photographers, events, images } = await collections();
    const result = await photographers.findOneAndUpdate(
        { _id: safeObjectId(req.photographer.id) },
        { $set: updates },
        { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Account not found.' });

    if (updates.studioName) {
        await Promise.all([
            events.updateMany({ ownerId: req.photographer.id }, { $set: { studioName: updates.studioName } }),
            images.updateMany({ ownerId: req.photographer.id }, { $set: { studioName: updates.studioName } })
        ]);
    }

    setSessionCookie(res, signPhotographerToken(result));
    return res.json({ success: true, photographer: publicPhotographer(result) });
}));

function safeObjectId(value) {
    try {
        const { ObjectId } = require('mongodb');
        return new ObjectId(String(value));
    } catch (error) {
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Events (photographer)                                               */
/* ------------------------------------------------------------------ */

app.post('/api/events', requirePhotographer, asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Give the collection a name.' });

    let eventDate = null;
    if (req.body.eventDate) {
        const parsed = new Date(req.body.eventDate);
        if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Event date is invalid.' });
        eventDate = parsed;
    }

    const base = slugify(req.body.eventId || name) || `event-${randomSuffix()}`;
    const { events } = await collections();

    let eventId = base;
    for (let attempt = 2; attempt < 60; attempt += 1) {
        const taken = await events.findOne({ eventId }, { projection: { _id: 1 } });
        if (!taken) break;
        eventId = `${base}-${attempt}`;
    }

    const doc = {
        eventId,
        name,
        studioName: req.photographer.studioName || config.watermarkText,
        ownerId: req.photographer.id,
        active: true,
        eventDate,
        createdAt: new Date()
    };
    await events.insertOne(doc);

    return res.status(201).json({ success: true, event: shapeEvent(req, doc) });
}));

app.get('/api/events', requirePhotographer, asyncHandler(async (req, res) => {
    const { events } = await collections();
    const rows = await events
        .find({ ownerId: req.photographer.id })
        .sort({ createdAt: -1 })
        .limit(200)
        .toArray();

    const counts = await buildEventCounts(rows.map((row) => row.eventId));
    return res.json({
        success: true,
        events: rows.map((row) => shapeEvent(req, row, counts.get(row.eventId)))
    });
}));

app.get('/api/events/:eventId', requirePhotographer, asyncHandler(async (req, res) => {
    const event = await findOwnedEvent(req.params.eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const counts = await buildEventCounts([event.eventId]);
    return res.json({ success: true, event: shapeEvent(req, event, counts.get(event.eventId)) });
}));

app.patch('/api/events/:eventId', requirePhotographer, asyncHandler(async (req, res) => {
    const event = await findOwnedEvent(req.params.eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const updates = {};
    if (req.body.name != null) {
        const name = String(req.body.name).trim();
        if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Give the collection a name.' });
        updates.name = name;
    }
    if (req.body.active != null) updates.active = Boolean(req.body.active);
    if (req.body.eventDate !== undefined) {
        if (!req.body.eventDate) updates.eventDate = null;
        else {
            const parsed = new Date(req.body.eventDate);
            if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'Event date is invalid.' });
            updates.eventDate = parsed;
        }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { events } = await collections();
    const result = await events.findOneAndUpdate(
        { eventId: event.eventId, ownerId: req.photographer.id },
        { $set: updates },
        { returnDocument: 'after' }
    );

    const counts = await buildEventCounts([event.eventId]);
    return res.json({ success: true, event: shapeEvent(req, result, counts.get(event.eventId)) });
}));

app.delete('/api/events/:eventId', requirePhotographer, asyncHandler(async (req, res) => {
    const event = await findOwnedEvent(req.params.eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const { events, images, customers, matches } = await collections();
    const rows = await images
        .find({ eventId: event.eventId, ownerId: req.photographer.id })
        .project({ publicId: 1, previewPublicId: 1, deliveryType: 1, faceIds: 1 })
        .toArray();

    await Promise.allSettled([
        deleteVectors(rows.flatMap((row) => row.faceIds || [])),
        destroyPhotoAssets(rows)
    ]);

    await Promise.all([
        images.deleteMany({ eventId: event.eventId, ownerId: req.photographer.id }),
        customers.deleteMany({ eventId: event.eventId, ownerId: req.photographer.id }),
        matches.deleteMany({ eventId: event.eventId }),
        events.deleteOne({ eventId: event.eventId, ownerId: req.photographer.id })
    ]);

    return res.json({ success: true, deletedPhotos: rows.length });
}));

app.get('/api/events/:eventId/photos', requirePhotographer, asyncHandler(async (req, res) => {
    const event = await findOwnedEvent(req.params.eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const { images } = await collections();
    const query = { eventId: event.eventId, ownerId: req.photographer.id };
    const [rows, total] = await Promise.all([
        images
            .find(query)
            .sort({ uploadedAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray(),
        images.countDocuments(query)
    ]);

    return res.json({
        success: true,
        photos: rows.map(shapeOwnerPhoto),
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit))
    });
}));

app.get('/api/events/:eventId/customers', requirePhotographer, asyncHandler(async (req, res) => {
    const event = await findOwnedEvent(req.params.eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const { customers } = await collections();
    const rows = await customers
        .find({ eventId: event.eventId, ownerId: req.photographer.id })
        .sort({ registeredAt: -1 })
        .limit(500)
        .toArray();

    return res.json({
        success: true,
        customers: rows.map((row) => ({
            name: row.name,
            phone: row.phone,
            registeredAt: row.registeredAt
        }))
    });
}));

app.get('/api/events/:eventId/matches', requirePhotographer, asyncHandler(async (req, res) => {
    const event = await findOwnedEvent(req.params.eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const { matches } = await collections();
    const rows = await matches
        .find({ eventId: event.eventId })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

    return res.json({
        success: true,
        matches: rows.map((row) => ({
            customerName: row.customerName,
            photoCount: row.photoCount,
            createdAt: row.createdAt
        }))
    });
}));

/* ------------------------------------------------------------------ */
/* Uploads and face indexing (photographer)                            */
/* ------------------------------------------------------------------ */

app.post('/api/upload-storage', requirePhotographer, photoUpload.array('images', config.maxUploadFiles), asyncHandler(async (req, res) => {
    const eventId = String(req.body.eventId || '').trim();
    if (!eventId) return res.status(400).json({ error: 'Choose a collection before uploading.' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No image files provided.' });

    const event = await findOwnedEvent(eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    const folder = `${config.uploadFolder}/${event.eventId}`;
    const watermark = event.studioName || config.watermarkText;
    const settled = await Promise.allSettled(
        req.files.map((file) => uploadPhoto(file.buffer, { folder, watermarkText: watermark }))
    );

    const assets = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const failure = settled.find((item) => item.status === 'rejected');

    if (failure) {
        // Keep batches atomic: if one file fails, remove whichever files did
        // upload so the photographer can retry the batch cleanly.
        await destroyPhotoAssets(assets);
        throw failure.reason;
    }

    return res.json({
        success: true,
        assets,
        urls: assets.map((asset) => asset.url)
    });
}));

app.post('/api/upload-webhook', requirePhotographer, asyncHandler(async (req, res) => {
    const eventId = String(req.body.eventId || '').trim();
    if (!eventId) return res.status(400).json({ error: 'Choose a collection before indexing.' });

    const event = await findOwnedEvent(eventId, req.photographer.id);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    let incoming = Array.isArray(req.body.images) ? req.body.images : [];
    if (incoming.length === 0 && Array.isArray(req.body.imageUrls)) {
        incoming = req.body.imageUrls.map((url) => ({ url }));
    }
    if (incoming.length === 0) return res.status(400).json({ error: 'No images to index.' });
    if (incoming.length > config.maxUploadFiles) {
        return res.status(400).json({ error: `Index at most ${config.maxUploadFiles} images per request.` });
    }

    const { images } = await collections();
    const results = [];
    let totalFaces = 0;
    const eventFolder = `${config.uploadFolder}/${event.eventId}`;

    for (const item of incoming) {
        const providedUrl = item.url || item.secureUrl || '';
        const deliveryType = item.deliveryType === 'authenticated'
            ? 'authenticated'
            : item.deliveryType === 'upload'
                ? 'upload'
                : deliveryTypeFromUrl(providedUrl);
        const publicId = item.publicId || publicIdFromUrl(providedUrl);
        if (!publicId) {
            results.push({ error: 'Image is missing its Cloudinary reference.' });
            continue;
        }
        if (publicId !== eventFolder && !publicId.startsWith(`${eventFolder}/`)) {
            results.push({ error: 'Image does not belong to this collection.' });
            continue;
        }

        const previewPublicId = typeof item.previewPublicId === 'string' && item.previewPublicId.startsWith(`${eventFolder}/`)
            ? item.previewPublicId
            : null;
        const originalUrl = buildSourceUrl(publicId, deliveryType);

        const imageId = `img_${Date.now().toString(36)}_${randomSuffix(6)}`;
        const doc = {
            imageId,
            publicId,
            deliveryType,
            previewPublicId,
            originalUrl,
            eventId: event.eventId,
            eventName: event.name,
            ownerId: req.photographer.id,
            studioName: event.studioName,
            width: item.width || null,
            height: item.height || null,
            bytes: item.bytes || null,
            facesCount: 0,
            faceIds: [],
            indexed: false,
            uploadedAt: new Date()
        };

        await images.insertOne(doc);

        let faceIds = [];
        try {
            const faces = await extractFaces(originalUrl);
            if (faces.length > 0) {
                const records = faces.map((face, index) => {
                    const id = `${imageId}_face_${index}`;
                    faceIds.push(id);
                    return {
                        id,
                        values: face.embedding,
                        metadata: {
                            imageId,
                            eventId: event.eventId,
                            ownerId: req.photographer.id
                        }
                    };
                });
                await upsertFaces(records);
                totalFaces += faces.length;
            }

            await images.updateOne(
                { imageId },
                { $set: { facesCount: faces.length, faceIds, indexed: true, indexedAt: new Date(), indexError: null } }
            );
            results.push({ imageId, faces: faces.length, indexed: true });
        } catch (error) {
            // A failed upsert can leave a partial batch in Pinecone. Remove any
            // vectors written for this image so a retry starts from a clean slate.
            await deleteVectors(faceIds).catch(() => {});
            const message = error instanceof AiServiceError ? error.message : 'Face indexing failed.';
            await images.updateOne(
                { imageId },
                { $set: { facesCount: 0, faceIds: [], indexed: false, indexError: message } }
            );
            results.push({ imageId, faces: 0, indexed: false, error: message });
        }
    }

    await collections().then(({ events }) =>
        events.updateOne({ eventId: event.eventId }, { $set: { lastIngestAt: new Date() } })
    );

    return res.status(201).json({
        success: true,
        processedCount: results.filter((row) => row.imageId).length,
        facesIndexed: totalFaces,
        results
    });
}));

app.post('/api/photos/:imageId/reindex', requirePhotographer, asyncHandler(async (req, res) => {
    const { images } = await collections();
    const image = await images.findOne({ imageId: req.params.imageId, ownerId: req.photographer.id });
    if (!image) return res.status(404).json({ error: 'Photo not found.' });

    await deleteVectors(image.faceIds || []);

    let faceIds = [];
    try {
        const sourceUrl = buildSourceUrl(image.publicId, image.deliveryType || 'upload');
        const faces = await extractFaces(sourceUrl);
        faceIds = faces.map((face, index) => `${image.imageId}_face_${index}`);

        await upsertFaces(
            faces.map((face, index) => ({
                id: faceIds[index],
                values: face.embedding,
                metadata: { imageId: image.imageId, eventId: image.eventId, ownerId: image.ownerId }
            }))
        );

        await images.updateOne(
            { imageId: image.imageId },
            { $set: { facesCount: faces.length, faceIds, indexed: true, indexedAt: new Date(), indexError: null } }
        );

        return res.json({ success: true, imageId: image.imageId, faces: faces.length });
    } catch (error) {
        await deleteVectors(faceIds).catch(() => {});
        const message = error instanceof AiServiceError ? error.message : 'Face indexing failed.';
        await images.updateOne(
            { imageId: image.imageId },
            { $set: { facesCount: 0, faceIds: [], indexed: false, indexError: message } }
        );
        throw error;
    }
}));

app.delete('/api/photos/:imageId', requirePhotographer, asyncHandler(async (req, res) => {
    const { images } = await collections();
    const image = await images.findOne({ imageId: req.params.imageId, ownerId: req.photographer.id });
    if (!image) return res.status(404).json({ error: 'Photo not found.' });

    await Promise.allSettled([
        deleteVectors(image.faceIds || []),
        destroyPhotoAssets([image])
    ]);
    await images.deleteOne({ imageId: image.imageId });

    return res.json({ success: true, deleted: image.imageId });
}));

/* ------------------------------------------------------------------ */
/* Guest experience                                                    */
/* ------------------------------------------------------------------ */

app.get('/api/public/events/:eventId', asyncHandler(async (req, res) => {
    const event = await findEvent(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'That collection code was not found.' });

    const { images } = await collections();
    const photoCount = await images.countDocuments({ eventId: event.eventId });

    res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    return res.json({
        success: true,
        event: {
            eventId: event.eventId,
            name: event.name,
            studioName: event.studioName,
            eventDate: event.eventDate || null,
            photoCount,
            active: event.active !== false
        }
    });
}));

app.post('/api/customers/register', guestLimiter, asyncHandler(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const phone = normalizePhone(req.body.phone);
    const eventId = String(req.body.eventId || '').trim();

    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your full name.' });
    if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });
    if (!eventId) return res.status(400).json({ error: 'A collection code is required.' });

    const event = await findEvent(eventId);
    if (!event) return res.status(404).json({ error: 'That collection code was not found.' });
    if (event.active === false) return res.status(403).json({ error: 'This collection is no longer accepting guests.' });

    const { customers } = await collections();
    const now = new Date();
    const customer = await customers.findOneAndUpdate(
        { eventId: event.eventId, phone },
        {
            $set: { name, ownerId: event.ownerId, lastSeenAt: now },
            $setOnInsert: { eventId: event.eventId, phone, registeredAt: now }
        },
        { upsert: true, returnDocument: 'after' }
    );

    const guestToken = signGuestToken(customer);
    return res.status(201).json({
        success: true,
        guestToken,
        customer: { name: customer.name, phone: customer.phone },
        event: {
            eventId: event.eventId,
            name: event.name,
            studioName: event.studioName
        }
    });
}));

app.post('/api/match-gallery', matchLimiter, selfieUpload.single('selfie'), requireGuest, asyncHandler(async (req, res) => {
    const requestedEventId = String(req.body.eventId || req.guest.eventId).trim();
    if (requestedEventId !== req.guest.eventId) {
        return res.status(403).json({ error: 'This session belongs to a different collection.' });
    }

    const event = await findEvent(req.guest.eventId);
    if (!event) return res.status(404).json({ error: 'Collection not found.' });

    let selfieUrl = null;
    let uploadedSelfiePublicId = null;

    if (req.file) {
        const uploaded = await uploadSelfie(req.file.buffer);
        selfieUrl = uploaded.url;
        uploadedSelfiePublicId = uploaded.publicId;
    } else if (req.body.selfieUrl) {
        if (!isCloudinaryUrl(req.body.selfieUrl)) {
            return res.status(400).json({ error: 'Selfie must be uploaded through this application.' });
        }
        selfieUrl = req.body.selfieUrl;
    }

    if (!selfieUrl) return res.status(400).json({ error: 'A selfie is required.' });

    try {
        const faces = await extractFaces(selfieUrl);
        if (faces.length === 0) {
            return res.status(422).json({ error: 'No clear face was detected. Try a brighter, closer selfie.' });
        }

        const bestFace = pickBestFace(faces);
        const matches = await queryFaces({
            vector: bestFace.embedding,
            eventId: event.eventId,
            topK: config.matchTopK
        });

        // Collapse multiple faces from one photo down to its best score.
        const bestByImage = new Map();
        matches.forEach((match) => {
            if (!match.metadata || !match.metadata.imageId) return;
            const score = Number(match.score) || 0;
            if (score < config.matchThreshold) return;
            const current = bestByImage.get(match.metadata.imageId);
            if (!current || score > current) bestByImage.set(match.metadata.imageId, score);
        });

        let photos = [];
        if (bestByImage.size > 0) {
            const { images, matches: matchLog } = await collections();
            const rows = await images
                .find({
                    imageId: { $in: [...bestByImage.keys()] },
                    eventId: event.eventId
                })
                .toArray();

            const watermark = event.studioName || config.watermarkText;
            const preparedRows = await mapLimit(rows, 4, (image) =>
                ensurePhotoPreview(image, image.studioName || watermark)
            );

            photos = preparedRows
                .map((image) => shapeGuestPhoto(image, bestByImage.get(image.imageId) || 0, watermark))
                .sort((a, b) => b.score - a.score);

            await matchLog
                .insertOne({
                    eventId: event.eventId,
                    customerId: req.guest.id,
                    customerName: req.guest.name,
                    photoCount: photos.length,
                    createdAt: new Date()
                })
                .catch(() => {});
        }

        return res.json({
            success: true,
            photos,
            matchCount: photos.length,
            threshold: config.matchThreshold
        });
    } finally {
        if (uploadedSelfiePublicId) await destroyAsset(uploadedSelfiePublicId);
    }
}));

/* ------------------------------------------------------------------ */
/* Fallbacks                                                           */
/* ------------------------------------------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));

app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error instanceof multer.MulterError) {
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        const message = error.code === 'LIMIT_FILE_SIZE'
            ? 'That image is too large. Try a smaller file.'
            : error.message;
        return res.status(status).json({ error: message });
    }
    if (error.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (error instanceof AiServiceError) {
        return res.status(error.status || 502).json({ error: error.message });
    }
    if (error.status && error.status < 500) {
        return res.status(error.status).json({ error: error.message });
    }

    console.error('[api] Unhandled error:', error);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = app;
