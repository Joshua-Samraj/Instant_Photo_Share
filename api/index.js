require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { MongoClient } = require('mongodb');
const { Pinecone } = require('@pinecone-database/pinecone');

const app = express();
app.use(express.json());

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'customer.html'));
});

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ storage: multer.memoryStorage() });

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db, imagesCollection, customersCollection;
async function connectMongo() {
    if (!db) {
        await mongoClient.connect();
        db = mongoClient.db('snapsync_prod');
        imagesCollection = db.collection('images');
        customersCollection = db.collection('customers');
        console.log("Connected to MongoDB Atlas");
    }
}

const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index(process.env.PINECONE_INDEX_NAME || 'snapsync');

const PYTHON_SERVICE_URL = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';

const uploadToCloudinary = (fileBuffer) => {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: "snapsync_events" },
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        stream.end(fileBuffer);
    });
};

app.post('/api/upload-storage', upload.array('images', 50), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: "No image files provided" });
        }
        const uploadPromises = req.files.map(file => uploadToCloudinary(file.buffer));
        const fileUrls = await Promise.all(uploadPromises);
        res.json({ success: true, urls: fileUrls });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload-webhook', async (req, res) => {
    try {
        await connectMongo();
        const { imageUrls, eventId, eventName } = req.body;
        const urlsToProcess = Array.isArray(imageUrls) ? imageUrls : [req.body.imageUrl].filter(Boolean);
        
        if (urlsToProcess.length === 0 || !eventId) {
            return res.status(400).json({ error: "Missing imageUrls or eventId arguments" });
        }

        let totalFacesIndexed = 0;
        const processedImages = [];

        for (const imageUrl of urlsToProcess) {
            const imageId = `img_${Date.now()}_${Math.round(Math.random() * 10000)}`;
            const doc = { 
                imageId, 
                url: imageUrl, 
                eventId: String(eventId), 
                eventName: eventName || String(eventId),
                uploadedAt: new Date() 
            };
            await imagesCollection.insertOne(doc);
            processedImages.push(doc);

            try {
                const aiResponse = await axios.post(`${PYTHON_SERVICE_URL}/extract-embeddings`, { image_url: imageUrl });
                const detectedFaces = aiResponse.data.faces;
                if (detectedFaces && detectedFaces.length > 0) {
                    const records = detectedFaces.map((face, idx) => ({
                        id: `${imageId}_face_${idx}`,
                        values: face.embedding,
                        metadata: { imageId, eventId: String(eventId) }
                    }));
                    await index.upsert(records);
                    totalFacesIndexed += detectedFaces.length;
                }
            } catch (aiErr) {
                console.error(`AI extraction failed for ${imageUrl}:`, aiErr.message);
            }
        }

        res.status(201).json({ success: true, processedCount: processedImages.length, facesIndexed: totalFacesIndexed });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/customers/register', async (req, res) => {
    try {
        await connectMongo();
        const { name, phone, eventId } = req.body;
        if (!name || !phone || !eventId) return res.status(400).json({ error: "Name, phone, and Event ID are required." });

        const customerDoc = { name, phone, eventId: String(eventId), registeredAt: new Date() };
        await customersCollection.insertOne(customerDoc);
        res.status(201).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/match-gallery', async (req, res) => {
    try {
        await connectMongo();
        const { selfieUrl, eventId } = req.body;
        if (!selfieUrl || !eventId) return res.status(400).json({ error: "Missing arguments" });

        const aiResponse = await axios.post(`${PYTHON_SERVICE_URL}/extract-embeddings`, { image_url: selfieUrl });
        const guestFaces = aiResponse.data.faces;
        if (!guestFaces || guestFaces.length === 0) {
            return res.status(400).json({ error: "No clear facial profiles identified in selfie upload" });
        }

        const queryResponse = await index.query({
            vector: guestFaces[0].embedding,
            filter: { eventId: { $eq: String(eventId) } },
            topK: 30,
            includeMetadata: true
        });

        if (!queryResponse.matches || queryResponse.matches.length === 0) return res.json({ photos: [] });

        const validMatches = queryResponse.matches.filter(match => match.score >= 0.55);
        if (validMatches.length === 0) return res.json({ photos: [] });

        const matchedImageIds = [...new Set(validMatches.map(match => match.metadata.imageId))];
        const matchingGalleryPhotos = await imagesCollection.find({ imageId: { $in: matchedImageIds } }).toArray();

        res.json({ photos: matchingGalleryPhotos });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/events', async (req, res) => {
    try {
        await connectMongo();
        const images = await imagesCollection.find({}).toArray();
        const customers = await customersCollection.find({}).toArray();

        const eventMap = {};
        images.forEach(img => {
            if (!eventMap[img.eventId]) {
                eventMap[img.eventId] = { eventId: img.eventId, eventName: img.eventName || img.eventId, photoCount: 0, customers: [] };
            }
            eventMap[img.eventId].photoCount++;
        });

        customers.forEach(cust => {
            if (!eventMap[cust.eventId]) {
                eventMap[cust.eventId] = { eventId: cust.eventId, eventName: cust.eventId, photoCount: 0, customers: [] };
            }
            eventMap[cust.eventId].customers.push({ name: cust.name, phone: cust.phone, registeredAt: cust.registeredAt });
        });

        res.json({ success: true, events: Object.values(eventMap) });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Local dev server running on http://localhost:${PORT}`));
}