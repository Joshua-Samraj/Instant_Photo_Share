require('dotenv').config();

const { Pinecone } = require('@pinecone-database/pinecone');

const INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'snapsync';
const DIMENSION = 512; // ArcFace
const METRIC = 'cosine';

(async () => {
    if (!process.env.PINECONE_API_KEY) {
        console.error('PINECONE_API_KEY is not set.');
        process.exit(1);
    }

    const client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

    try {
        const description = await client.describeIndex(INDEX_NAME);
        console.log(`Index "${INDEX_NAME}" already exists.`);
        console.log(`  dimension: ${description.dimension}`);
        console.log(`  metric:    ${description.metric}`);
        console.log(`  host:      ${description.host}`);

        if (Number(description.dimension) !== DIMENSION || description.metric !== METRIC) {
            console.error(`\nThis index is incompatible. ArcFace needs ${DIMENSION} dimensions with ${METRIC} metric.`);
            process.exit(1);
        }
        process.exit(0);
    } catch (error) {
        if (!/not found|404/i.test(`${error.message} ${error.status || ''}`)) {
            console.error(`Could not describe index: ${error.message}`);
            process.exit(1);
        }
    }

    console.log(`Creating "${INDEX_NAME}" (${DIMENSION}d, ${METRIC})…`);
    await client.createIndex({
        name: INDEX_NAME,
        dimension: DIMENSION,
        metric: METRIC,
        spec: { serverless: { cloud: 'aws', region: process.env.PINECONE_REGION || 'us-east-1' } }
    });
    console.log('Index created. It may take a minute to become ready.');
})();
