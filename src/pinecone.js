const { Pinecone } = require('@pinecone-database/pinecone');
const config = require('./config');

let client;
let index;

function getIndex() {
    if (!index) {
        client = client || new Pinecone({ apiKey: config.pineconeApiKey });
        index = client.index(config.pineconeIndex);
    }
    return index;
}

function chunk(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

async function upsertFaces(records) {
    const valid = records.filter(
        (record) => record && record.id && Array.isArray(record.values) && record.values.length > 0
    );
    if (valid.length === 0) return 0;

    for (const batch of chunk(valid, 100)) {
        await getIndex().upsert(batch);
    }
    return valid.length;
}

async function deleteVectors(ids) {
    const valid = [...new Set((ids || []).filter(Boolean))];
    if (valid.length === 0) return 0;

    for (const batch of chunk(valid, 1000)) {
        await getIndex().deleteMany(batch);
    }
    return valid.length;
}

async function queryFaces({ vector, eventId, topK }) {
    const response = await getIndex().query({
        vector,
        topK: topK || config.matchTopK,
        filter: { eventId: { $eq: String(eventId) } },
        includeMetadata: true,
        includeValues: false
    });
    return Array.isArray(response.matches) ? response.matches : [];
}

async function pineconeHealth() {
    const started = Date.now();
    try {
        const stats = await getIndex().describeIndexStats();
        return {
            ok: true,
            latencyMs: Date.now() - started,
            totalRecords: stats.totalRecordCount
        };
    } catch (error) {
        return { ok: false, latencyMs: Date.now() - started, error: error.message };
    }
}

module.exports = {
    getIndex,
    upsertFaces,
    deleteVectors,
    queryFaces,
    pineconeHealth
};
