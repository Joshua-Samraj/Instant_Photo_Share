const { MongoClient } = require('mongodb');
const config = require('./config');

/**
 * Serverless functions are reused between invocations, so we cache the client
 * on globalThis instead of opening a brand new connection per request.
 */
const cache = globalThis.__snapsyncMongo || (globalThis.__snapsyncMongo = {
    client: null,
    promise: null,
    db: null
});

function createClient() {
    return new MongoClient(config.mongoUri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
    });
}

async function ensureIndexes(db) {
    // Index creation is idempotent; calling it on every cold start is cheap.
    await Promise.allSettled([
        db.collection('photographers').createIndex({ email: 1 }, { unique: true }),
        db.collection('events').createIndex({ eventId: 1 }, { unique: true }),
        db.collection('events').createIndex({ ownerId: 1, createdAt: -1 }),
        db.collection('images').createIndex({ imageId: 1 }, { unique: true }),
        db.collection('images').createIndex({ eventId: 1, uploadedAt: -1 }),
        db.collection('images').createIndex({ ownerId: 1 }),
        db.collection('customers').createIndex({ eventId: 1, phone: 1 }, { unique: true }),
        db.collection('customers').createIndex({ ownerId: 1 }),
        db.collection('matches').createIndex({ eventId: 1, createdAt: -1 }),
        db.collection('matches').createIndex({ customerId: 1 })
    ]);
}

async function getDb() {
    if (cache.db) return cache.db;
    if (!config.mongoUri) throw new Error('MONGODB_URI is not configured.');

    if (!cache.promise) {
        if (!cache.client) cache.client = createClient();
        cache.promise = cache.client
            .connect()
            .then(async (client) => {
                const db = client.db(config.mongoDb);
                await ensureIndexes(db);
                cache.db = db;
                console.log(`[db] Connected to MongoDB database "${config.mongoDb}"`);
                return db;
            })
            .catch((error) => {
                // Allow a later request to retry after a transient outage.
                cache.promise = null;
                throw error;
            });
    }

    return cache.promise;
}

async function collections() {
    const db = await getDb();
    return {
        db,
        photographers: db.collection('photographers'),
        events: db.collection('events'),
        images: db.collection('images'),
        customers: db.collection('customers'),
        matches: db.collection('matches')
    };
}

async function pingDatabase() {
    const db = await getDb();
    await db.command({ ping: 1 });
    return true;
}

module.exports = { getDb, collections, pingDatabase };
