const { v2: cloudinary } = require('cloudinary');
const config = require('./config');

cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true
});

const PREVIEW_SUFFIX = '_preview';
const AUTHENTICATED = 'authenticated';
const PUBLIC = 'upload';

function normalizedType(deliveryType) {
    return deliveryType === AUTHENTICATED ? AUTHENTICATED : PUBLIC;
}

function uploadStream(buffer, options) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            return resolve(result);
        });
        stream.end(buffer);
    });
}

function assetFromResult(result) {
    return {
        publicId: result.public_id,
        deliveryType: normalizedType(result.type),
        url: result.secure_url,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        format: result.format
    };
}

/**
 * Originals are uploaded as Cloudinary "authenticated" assets. An unsigned
 * request for one returns 401, and the only signed URLs we create are handed
 * to the owning photographer or used server-side for face analysis.
 */
async function uploadPhoto(buffer, options = {}) {
    const folder = options.folder || config.uploadFolder;
    const watermark = options.watermarkText || config.watermarkText;

    const result = await uploadStream(buffer, {
        folder,
        resource_type: 'image',
        type: AUTHENTICATED,
        unique_filename: true,
        overwrite: false,
        ...(options.tags ? { tags: options.tags } : {})
    });

    const photo = assetFromResult(result);

    try {
        const preview = await createPreviewAsset(photo.publicId, photo.deliveryType, watermark);
        photo.previewPublicId = preview.publicId;
        photo.previewUrl = preview.url;
    } catch (error) {
        // Never leave an original behind without a guest-safe derivative.
        await destroyAsset(photo.publicId, photo.deliveryType);
        throw error;
    }

    // The upload result's secure_url is unsigned and would return 401 for an
    // authenticated asset, so replace it with a signed owner URL.
    photo.url = buildSourceUrl(photo.publicId, photo.deliveryType);

    return photo;
}

/**
 * Selfies are temporary. They are uploaded publicly so the face service can
 * fetch them, then deleted as soon as the match request completes.
 */
async function uploadSelfie(buffer) {
    const result = await uploadStream(buffer, {
        folder: config.selfieFolder,
        resource_type: 'image',
        type: PUBLIC,
        unique_filename: true,
        overwrite: false,
        tags: ['temporary', 'selfie']
    });
    return assetFromResult(result);
}

function watermarkLayer(text, opacity = 40) {
    const safeText = encodeURIComponent(String(text || config.watermarkText).slice(0, 64));
    return `l_text:Arial_56:${safeText},co_rgb:FFFFFF,o_${opacity},g_center`;
}

function previewTransformation(text) {
    return [
        `w_${config.previewWidth},c_limit,q_auto:good,f_jpg`,
        watermarkLayer(text, 40)
    ].join('/');
}

function legacyDownloadTransformation(text, filename) {
    return [
        `w_${config.downloadWidth},c_limit,q_90`,
        watermarkLayer(text, 40),
        `fl_attachment:${safeFilename(filename)}`
    ].join('/');
}

function publicUrl(publicId) {
    return cloudinary.url(publicId, { type: PUBLIC, secure: true });
}

/**
 * Create a separate, public asset whose pixels are already watermarked. Guests
 * only ever see this asset, so removing transformations from the URL cannot
 * reveal the original.
 */
async function createPreviewAsset(publicId, deliveryType, text) {
    if (!publicId) throw new Error('A Cloudinary public ID is required.');

    const type = normalizedType(deliveryType);
    const sourceUrl = cloudinary.url(publicId, {
        type,
        secure: true,
        sign_url: type === AUTHENTICATED,
        raw_transformation: previewTransformation(text)
    });

    const derived = await cloudinary.uploader.upload(sourceUrl, {
        public_id: `${publicId}${PREVIEW_SUFFIX}`,
        resource_type: 'image',
        type: PUBLIC,
        overwrite: true,
        invalidate: true
    });

    return {
        publicId: derived.public_id,
        url: publicUrl(derived.public_id),
        bytes: derived.bytes,
        format: derived.format
    };
}

async function destroyAsset(publicId, deliveryType = PUBLIC) {
    if (!publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId, {
            type: normalizedType(deliveryType),
            invalidate: true,
            resource_type: 'image'
        });
    } catch (error) {
        console.error(`[cloudinary] Failed to delete ${publicId}:`, error.message);
    }
}

async function destroyAssets(publicIds, deliveryType = PUBLIC, concurrency = 8) {
    const ids = [...new Set(publicIds.filter(Boolean))];
    for (let index = 0; index < ids.length; index += concurrency) {
        const chunk = ids.slice(index, index + concurrency);
        await Promise.allSettled(chunk.map((id) => destroyAsset(id, deliveryType)));
    }
}

/**
 * Delete an original and its watermarked preview (used by both stored image
 * documents and freshly uploaded asset descriptors).
 */
async function destroyPhotoAssets(photos, concurrency = 8) {
    const jobs = [];
    const seen = new Set();

    for (const photo of photos || []) {
        if (!photo || !photo.publicId) continue;
        const originalType = normalizedType(photo.deliveryType);
        const originalKey = `${originalType}:${photo.publicId}`;
        if (!seen.has(originalKey)) {
            seen.add(originalKey);
            jobs.push({ publicId: photo.publicId, deliveryType: originalType });
        }
        if (photo.previewPublicId) {
            const previewKey = `${PUBLIC}:${photo.previewPublicId}`;
            if (!seen.has(previewKey)) {
                seen.add(previewKey);
                jobs.push({ publicId: photo.previewPublicId, deliveryType: PUBLIC });
            }
        }
    }

    for (let index = 0; index < jobs.length; index += concurrency) {
        const chunk = jobs.slice(index, index + concurrency);
        await Promise.allSettled(chunk.map((job) => destroyAsset(job.publicId, job.deliveryType)));
    }
}

function safeFilename(filename) {
    return String(filename || 'natural-studio')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'natural-studio';
}

/**
 * Signed URL for one of the photographer's own originals.
 */
function buildSourceUrl(publicId, deliveryType = PUBLIC) {
    const type = normalizedType(deliveryType);
    return cloudinary.url(publicId, {
        type,
        secure: true,
        sign_url: type === AUTHENTICATED
    });
}

/**
 * Un-watermarked derivative for the owning photographer's dashboard.
 */
function buildOwnerUrl(publicId, width, deliveryType = PUBLIC) {
    const type = normalizedType(deliveryType);
    return cloudinary.url(publicId, {
        type,
        secure: true,
        sign_url: type === AUTHENTICATED,
        ...(width ? { raw_transformation: `w_${width},c_limit,q_auto:good,f_auto` } : {})
    });
}

/**
 * Guests receive the stored watermarked preview. The legacy branch keeps old
 * "upload"-type assets working until scripts/migrate-media.js is run.
 */
function buildPreviewUrl(image, text) {
    if (image.previewPublicId) return publicUrl(image.previewPublicId);
    const type = normalizedType(image.deliveryType);
    return cloudinary.url(image.publicId, {
        type,
        secure: true,
        sign_url: type === AUTHENTICATED,
        raw_transformation: previewTransformation(text)
    });
}

function buildDownloadUrl(image, text, filename) {
    const attachment = `fl_attachment:${safeFilename(filename)}`;
    if (image.previewPublicId) {
        return cloudinary.url(image.previewPublicId, {
            type: PUBLIC,
            secure: true,
            raw_transformation: attachment
        });
    }
    const type = normalizedType(image.deliveryType);
    return cloudinary.url(image.publicId, {
        type,
        secure: true,
        sign_url: type === AUTHENTICATED,
        raw_transformation: legacyDownloadTransformation(text, filename)
    });
}

module.exports = {
    cloudinary,
    AUTHENTICATED,
    PUBLIC,
    uploadPhoto,
    uploadSelfie,
    createPreviewAsset,
    destroyAsset,
    destroyAssets,
    destroyPhotoAssets,
    buildSourceUrl,
    buildPreviewUrl,
    buildDownloadUrl,
    buildOwnerUrl
};
