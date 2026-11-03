require('dotenv').config();

const config = require('../src/config');
const { collections } = require('../src/db');
const {
    cloudinary,
    createPreviewAsset,
    buildSourceUrl,
    AUTHENTICATED,
    PUBLIC
} = require('../src/media');

/**
 * Upgrade photos created before the private-media change:
 *   1. Move each public "upload" original to Cloudinary "authenticated" type.
 *   2. Create a public, pixels-already-watermarked preview asset.
 *   3. Persist deliveryType / previewPublicId and a fresh signed source URL.
 *
 * Usage:
 *   node scripts/migrate-media.js            # dry run, prints the plan
 *   node scripts/migrate-media.js --apply    # perform the migration
 */

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 4;

async function mapLimit(items, limit, worker) {
    let cursor = 0;
    async function run() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
}

function describe(image) {
    return `${image.eventId}/${image.imageId}`;
}

async function migrateImage(image) {
    if (!image.publicId) {
        return { status: 'skipped', reason: 'missing publicId' };
    }

    let deliveryType = image.deliveryType === AUTHENTICATED ? AUTHENTICATED : PUBLIC;
    let previewPublicId = image.previewPublicId || null;

    if (deliveryType === PUBLIC) {
        if (APPLY) {
            await cloudinary.uploader.rename(image.publicId, image.publicId, {
                type: PUBLIC,
                to_type: AUTHENTICATED,
                overwrite: true,
                invalidate: true,
                resource_type: 'image'
            });
        }
        deliveryType = AUTHENTICATED;
    }

    if (!previewPublicId) {
        if (APPLY) {
            const preview = await createPreviewAsset(
                image.publicId,
                deliveryType,
                image.studioName || config.watermarkText
            );
            previewPublicId = preview.publicId;
        } else {
            previewPublicId = `${image.publicId}_preview`;
        }
    }

    if (APPLY) {
        const { images } = await collections();
        await images.updateOne(
            { imageId: image.imageId },
            {
                $set: {
                    deliveryType,
                    previewPublicId,
                    originalUrl: buildSourceUrl(image.publicId, deliveryType),
                    mediaMigratedAt: new Date()
                }
            }
        );
    }

    return { status: 'migrated' };
}

(async () => {
    const { images } = await collections();
    const rows = await images.find({}).project({
        imageId: 1,
        eventId: 1,
        publicId: 1,
        deliveryType: 1,
        previewPublicId: 1,
        studioName: 1
    }).toArray();

    console.log(`Found ${rows.length} photo(s). Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    await mapLimit(rows, CONCURRENCY, async (image) => {
        try {
            const result = await migrateImage(image);
            if (result.status === 'migrated') {
                migrated += 1;
                console.log(`ok   ${describe(image)}`);
            } else {
                skipped += 1;
                console.log(`skip ${describe(image)} (${result.reason})`);
            }
        } catch (error) {
            failed += 1;
            console.error(`FAIL ${describe(image)}: ${error.message}`);
        }
    });

    console.log(`\n${APPLY ? 'Migrated' : 'Would migrate'}: ${migrated}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Failed: ${failed}`);

    if (!APPLY) {
        console.log('\nRe-run with --apply to make these changes.');
    }

    process.exit(failed > 0 ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
