const axios = require('axios');
const config = require('./config');

const EXPECTED_DIMENSION = 512;

class AiServiceError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.name = 'AiServiceError';
        this.status = status;
    }
}

function isHttpUrl(value) {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (error) {
        return false;
    }
}

async function extractFaces(imageUrl) {
    if (!isHttpUrl(imageUrl)) {
        throw new AiServiceError('A valid image URL is required.', 400);
    }

    let response;
    try {
        response = await axios.post(
            `${config.aiUrl}/extract-embeddings`,
            { image_url: imageUrl },
            {
                timeout: config.aiTimeoutMs,
                maxBodyLength: Infinity,
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.aiKey ? { 'X-API-Key': config.aiKey } : {})
                }
            }
        );
    } catch (error) {
        if (error.response) {
            const detail = error.response.data && (error.response.data.detail || error.response.data.error);
            throw new AiServiceError(
                detail || `Face service responded with ${error.response.status}.`,
                error.response.status >= 500 ? 502 : 422
            );
        }
        if (error.code === 'ECONNABORTED') {
            throw new AiServiceError('Face service timed out while analysing the image.', 504);
        }
        throw new AiServiceError('Face service is unreachable. Check PYTHON_API_URL.', 503);
    }

    const faces = Array.isArray(response.data && response.data.faces) ? response.data.faces : [];
    return faces
        .filter((face) => Array.isArray(face.embedding) && face.embedding.length === EXPECTED_DIMENSION)
        .map((face) => ({
            embedding: face.embedding,
            box: face.box || face.facial_area || null
        }));
}

function boxArea(box) {
    if (!box) return 0;
    const width = Number(box.w != null ? box.w : box.width) || 0;
    const height = Number(box.h != null ? box.h : box.height) || 0;
    return width * height;
}

function pickBestFace(faces) {
    if (!faces || faces.length === 0) return null;
    return faces.reduce((best, face) => (boxArea(face.box) > boxArea(best.box) ? face : best), faces[0]);
}

async function aiHealth() {
    const started = Date.now();
    try {
        const response = await axios.get(`${config.aiUrl}/health`, {
            timeout: 15000,
            headers: config.aiKey ? { 'X-API-Key': config.aiKey } : {}
        });
        return { ok: true, latencyMs: Date.now() - started, detail: response.data };
    } catch (error) {
        return { ok: false, latencyMs: Date.now() - started, error: error.message };
    }
}

module.exports = {
    EXPECTED_DIMENSION,
    AiServiceError,
    extractFaces,
    pickBestFace,
    aiHealth
};
