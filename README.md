# SnapSync — Instant Photo Delivery

SnapSync is a facial-recognition photo delivery platform for studios and event photographers. A photographer creates a collection, uploads the shoot, and shares one link or QR code. Guests register, take a selfie, and instantly receive every photograph they appear in.

Guests receive **watermarked previews only**. The un-watermarked originals stay private to the photographer.

---

## Stack

| Layer | Technology |
| --- | --- |
| Web app / API | Node.js 20+, Express 4 |
| Database | MongoDB (Atlas in production) |
| Image storage & delivery | Cloudinary |
| Face vector index | Pinecone (512 dimensions, cosine) |
| Face embeddings | Python 3.10, FastAPI, DeepFace + ArcFace |
| Hosting | Vercel (web + API), Hugging Face Spaces (face service) |

## Architecture

```
Browser
  │
  ├── static pages ──────────────► Vercel (public/)
  │
  └── /api/* ────────────────────► Vercel serverless function
                                      │
                                      ├── MongoDB Atlas   (accounts, events, photos, guests)
                                      ├── Cloudinary      (authenticated originals, watermarked previews)
                                      ├── Pinecone        (face embeddings)
                                      └── HF Space        (DeepFace / ArcFace)
                                                             │
                                                             └── downloads image from Cloudinary
```

A single Express app lives in `src/app.js`. It is used by both local development (`server.js`) and Vercel (`api/[...path].js`), so there is no duplicated backend logic.

### Guest flow

1. Guest opens `/e/<eventId>` (or enters the collection code).
2. Guest registers with name and phone.
3. Guest submits a selfie (camera or upload). The selfie is compressed in the browser, uploaded to Cloudinary temporarily, and deleted immediately after matching.
4. The API extracts an ArcFace embedding, queries Pinecone filtered by `eventId`, and returns matching photos.
5. Guest sees watermarked previews and can download watermarked copies, individually or as a ZIP.

### Photographer flow

1. Register or sign in at `/login`.
2. Create a collection.
3. Upload photos in the dashboard. Images are compressed in the browser, stored in Cloudinary, then indexed by face.
4. Share the guest link or QR code.
5. Review photo counts, guest list, match activity, and delete/reindex frames as needed.

---

## Project layout

```
api/
  index.js            Vercel entry for /api
  [...path].js        Vercel catch-all entry for /api/*
src/
  app.js              Express app: all routes and middleware
  config.js           Environment validation and defaults
  db.js               Cached MongoDB connection + indexes
  auth.js             JWT sessions, password hashing, rate limiting
  media.js            Cloudinary uploads, authenticated originals, watermarked previews
  ai.js               Client for the Python face service
  pinecone.js         Pinecone upsert/query/delete helpers
public/
  index.html          Landing page
  login.html          Photographer sign in / registration
  photographer.html   Photographer dashboard (hash-routed SPA)
  customer.html       Guest portal and gallery
  404.html            Not-found page
  assets/ui.js        Shared fetch, toast, modal, image-compression helpers
main.py               FastAPI face service
Dockerfile            Face service image for Hugging Face Spaces
docker-compose.yml    Local MongoDB (+ optional face service)
scripts/              Syntax check, health check, Pinecone setup
```

---

## Local development

### 1. Requirements

- Node.js 20 or newer
- MongoDB 7 (Docker, or an Atlas connection string)
- Python 3.10 if you want to run the face service locally
- Cloudinary and Pinecone accounts

### 2. Install

```bash
npm install
cp .env.example .env
```

Fill in `.env`. At minimum you need MongoDB, Cloudinary, and Pinecone values. The face-service URL can stay at the local default while developing.

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Start MongoDB

```bash
docker compose up -d mongo
```

The default local URI is `mongodb://127.0.0.1:27017`. To use Atlas instead, paste the Atlas URI into `MONGODB_URI` and skip this step.

### 4. Start the face service

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 7860
```

Or with Docker:

```bash
docker compose --profile ai up -d
```

The first run downloads the ArcFace weights and can take several minutes. `GET /health` confirms the service is ready.

### 5. Start the web app

```bash
npm start          # http://localhost:3000
npm run dev        # restart on file changes
```

Useful checks:

```bash
npm run check      # parse every JavaScript file
npm run health     # deep health check: Mongo, Pinecone, face service
npm run setup:pinecone
```

---

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | production | Set to `production` on Vercel. Enables fail-fast config checks and secure cookies. |
| `PORT` | no | Local server port. Default `3000`. |
| `MONGODB_URI` | yes | MongoDB Atlas or local connection string. |
| `MONGODB_DB` | no | Database name. Default `snapsync_prod`. |
| `CLOUDINARY_CLOUD_NAME` | yes | Cloudinary cloud name. |
| `CLOUDINARY_API_KEY` | yes | Cloudinary API key. |
| `CLOUDINARY_API_SECRET` | yes | Cloudinary API secret. |
| `CLOUDINARY_UPLOAD_FOLDER` | no | Folder for event originals. Default `snapsync_events`. |
| `CLOUDINARY_SELFIE_FOLDER` | no | Temporary folder for selfies. Default `snapsync_selfies`. |
| `PINECONE_API_KEY` | yes | Pinecone API key. |
| `PINECONE_INDEX_NAME` | no | Index name. Default `snapsync`. Must be 512d, cosine. |
| `PYTHON_API_URL` | yes | Face service base URL, no trailing slash. |
| `PYTHON_API_KEY` | no | Shared secret sent as `X-API-Key`; must match the face service. |
| `PYTHON_API_TIMEOUT_MS` | no | Face-service timeout. Default `50000`. Keep below Vercel's 60 s limit. |
| `JWT_SECRET` | yes (prod) | Long random string used to sign sessions. |
| `SESSION_COOKIE_NAME` | no | Photographer cookie name. Default `snapsync_session`. |
| `SESSION_DAYS` | no | Photographer session length. Default `7`. |
| `GUEST_SESSION_HOURS` | no | Guest token lifetime. Default `12`. |
| `PUBLIC_BASE_URL` | recommended | Public origin used in share links and QR codes, e.g. `https://your-app.vercel.app`. |
| `MATCH_THRESHOLD` | no | Cosine similarity cutoff. Default `0.55`. |
| `MATCH_TOP_K` | no | Pinecone neighbours to inspect. Default `60`. |
| `WATERMARK_TEXT` | no | Fallback watermark when an event has no studio name. |
| `PREVIEW_WIDTH` | no | Width of the watermarked preview asset generated at upload. Default `1600`. |
| `DOWNLOAD_WIDTH` | no | Width used only for legacy photos that have no baked preview yet. Default `2400`. |
| `MAX_UPLOAD_FILES` | no | Server upload cap per request. Default `10`. |
| `MAX_UPLOAD_BYTES` | no | Max bytes per uploaded file. Default `10 MB`. |
| `MAX_SELFIE_BYTES` | no | Max selfie size. Default `8 MB`. |

Never commit `.env`.

---

## Service setup

### MongoDB Atlas

1. Create a free cluster.
2. Create a database user and allow network access from your hosts. Vercel functions use dynamic egress IPs, so Atlas usually needs `0.0.0.0/0` (or a restrictive proxy/tunnel if your security policy requires it).
3. Copy the driver connection string into `MONGODB_URI`.
4. Set `MONGODB_DB` to the database name you want to use.

Collections and indexes are created automatically on the first request.

### Cloudinary

1. Copy the cloud name, API key, and API secret from the Cloudinary console.
2. Originals are uploaded to `CLOUDINARY_UPLOAD_FOLDER/<eventId>`.
3. Selfies go to `CLOUDINARY_SELFIE_FOLDER` and are deleted immediately after matching.
4. Originals are stored as Cloudinary **authenticated** assets. The API never exposes an unsigned original URL; the owner dashboard receives signed URLs.
5. Each upload also produces a separate public preview asset whose pixels are already watermarked. Guests receive that preview asset, so removing or changing URL transformations cannot reveal the original. Preview assets are deleted together with their originals.

No strict-transformation setting is required. If you have photos from an older deployment (public `upload` assets), migrate them once:

```bash
npm run migrate:media            # dry run
npm run migrate:media -- --apply # move originals to authenticated + build previews
```

The migration is idempotent and safe to re-run.

### Pinecone

Create an index with:

- **Dimensions:** 512 (ArcFace)
- **Metric:** cosine

Or let the setup script create it:

```bash
npm run setup:pinecone
```

The existing `snapsync` index is compatible. The script refuses to continue if it finds an incompatible index.

### Face service (Hugging Face Spaces)

The included `Dockerfile` is ready for a Docker Space:

1. Create a new Space and choose **Docker** as the SDK.
2. Push this repository (or connect the GitHub repo) to the Space.
3. Add `PYTHON_API_KEY` as a Space secret.
4. Optionally set `FACE_MODEL` (default `ArcFace`) and `FACE_DETECTORS` (default `retinaface,mtcnn,ssd,opencv`).
5. Wait for the build. The health endpoint is `GET /health`.
6. Set `PYTHON_API_URL` on Vercel to the Space URL, for example `https://your-user-your-space.hf.space`.

Notes:

- Free CPU Spaces sleep when idle. The first request after sleep can exceed the 50 s timeout. Use paid hardware, a scheduled warm-up request (`POST /warmup`), or retry the first upload/index after waking the Space.
- The service downloads each image from Cloudinary, so the Space needs outbound network access (default).
- `PYTHON_API_KEY` is optional, but recommended for a public Space. Set the same value on Vercel.

---

## Deploying to Vercel

1. Import the repository into Vercel.
2. Add every required environment variable from the table above. Set `NODE_ENV=production` and `PUBLIC_BASE_URL=https://your-domain`.
3. Deploy. Vercel uses `api/[...path].js` for `/api/*`, serves `public/` statically, and rewrites clean URLs (`/e/:eventId`, `/dashboard`, `/login`).
4. After deployment:
   - Open `/api/health?deep=1` and confirm MongoDB, Pinecone, and the face service are all `ok`.
   - Register a photographer and create a test collection.
   - Upload one photo and confirm it is indexed.
   - Open the guest link in a private window, register, and match a selfie.
   - Confirm the guest preview is watermarked and the download works.
   - Delete the test collection to remove its Cloudinary assets and Pinecone vectors.

`vercel.json` sets functions to 60 s and 1024 MB. The client compresses photos before upload and sends them two at a time to stay under Vercel's ~4.5 MB request-body limit.

---

## API overview

### Public

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness. Add `?deep=1` to check Mongo, Pinecone, and the face service. |
| `GET` | `/api/public/events/:eventId` | Public collection metadata (name, studio, date, photo count). |
| `POST` | `/api/customers/register` | Guest registration; returns a short-lived guest JWT. |
| `POST` | `/api/match-gallery` | Selfie match. Requires a guest token (`Authorization: Bearer …` or `guestToken` field). |

### Photographer

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account. |
| `POST` | `/api/auth/login` | Sign in and set an httpOnly cookie. |
| `POST` | `/api/auth/logout` | Clear the session cookie. |
| `GET` | `/api/auth/me` | Current photographer. |
| `PATCH` | `/api/auth/profile` | Update name, studio name, or password. |
| `GET/POST` | `/api/events` | List or create collections. |
| `GET/PATCH/DELETE` | `/api/events/:eventId` | Read, update, or delete a collection. |
| `GET` | `/api/events/:eventId/photos` | Paginated photo list with owner-only URLs. |
| `GET` | `/api/events/:eventId/customers` | Registered guests. |
| `GET` | `/api/events/:eventId/matches` | Recent match activity. |
| `POST` | `/api/upload-storage` | Upload image buffers to Cloudinary. |
| `POST` | `/api/upload-webhook` | Store image metadata and index faces in Pinecone. |
| `POST` | `/api/photos/:imageId/reindex` | Re-run face extraction for one photo. |
| `DELETE` | `/api/photos/:imageId` | Delete a photo, its vectors, and its Cloudinary asset. |

---

## Security and privacy

- Photographer sessions are signed JWTs in an `httpOnly`, `SameSite=Lax` cookie; `Secure` is enabled in production.
- Passwords are hashed with bcrypt (cost 12).
- Guest access uses a separate short-lived JWT. **Explicit guest tokens take precedence over the photographer cookie**, so a photographer can test a guest link in the same browser.
- Every event, photo, customer, and match query is scoped by `ownerId` where appropriate.
- Cloudinary originals are stored as `authenticated` assets. Unsigned original requests return `401`, and only the owning photographer (or server-side face analysis) receives signed URLs.
- Guests receive a separate public **preview asset whose pixels are already watermarked**. They cannot strip a transformation to reach the original because the original is a different, authenticated resource.
- `/api/upload-webhook` only accepts public IDs inside the event's own Cloudinary folder, so a photographer cannot index arbitrary URLs.
- Selfies are uploaded to a temporary Cloudinary folder and deleted in a `finally` block after matching, including on failure.
- Auth, guest registration, and matching are rate-limited per instance. Serverless instances do not share memory, so this is best-effort; add a shared limiter (for example Upstash) if you need strict global limits.
- Production fails fast if required secrets are missing.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `MongoServerSelectionError` / timeout | Check `MONGODB_URI`, Atlas network access, and that the cluster is running. The old `livin.7wpgjap.mongodb.net` cluster no longer resolves. |
| `Face service is unreachable` | Check `PYTHON_API_URL`, that the Space is awake, and that `PYTHON_API_KEY` matches on both sides. |
| Face service times out | Free HF Spaces sleep. Wake the Space, use `/warmup`, or move to paid hardware. Vercel caps the function at 60 s. |
| Indexing returns `indexed: false` | Open the collection and use **Retry** on that frame. The error is stored in `indexError`. |
| Pinecone dimension error | The index must be 512d with cosine metric. Create a new one or run `npm run setup:pinecone`. |
| Vercel `413` on upload | The compressed batch is too large. Keep client compression enabled; each file should stay under ~2 MB. |
| Guest sees no matches | Lower `MATCH_THRESHOLD` slightly (for example `0.50`), use a clearer front-facing selfie, and confirm the photos are indexed (`facesCount > 0`). |
| Cloudinary upload `401` | Recheck cloud name, API key, and API secret. |
| QR/link points at `localhost` | Set `PUBLIC_BASE_URL` to the deployed origin. |

---

## Scripts

```bash
npm run check            # syntax-check backend and shared client JS
npm run health           # deep health check against localhost or HEALTH_BASE_URL
npm run setup:pinecone   # verify or create the Pinecone index
npm run migrate:media    # dry-run the legacy Cloudinary media upgrade
npm start                # production-style local server
npm run dev              # watch mode
```

## License

Private project. All rights reserved.
