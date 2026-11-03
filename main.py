import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import cv2
import numpy as np
import requests
from deepface import DeepFace
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, HttpUrl
import uvicorn

MODEL_NAME = os.environ.get("FACE_MODEL", "ArcFace")
EMBEDDING_DIMENSION = 512
DETECTORS = [
    value.strip()
    for value in os.environ.get("FACE_DETECTORS", "retinaface,mtcnn,ssd,opencv").split(",")
    if value.strip()
]
API_KEY = os.environ.get("PYTHON_API_KEY") or os.environ.get("AI_API_KEY") or ""
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", str(25 * 1024 * 1024)))
DOWNLOAD_TIMEOUT = (5, 25)

app = FastAPI(title="SnapSync Face Service", version="2.0.0")


class ImageRequest(BaseModel):
    image_url: HttpUrl


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """Optional shared secret so only our backend can consume face embeddings."""
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def download_image_to_cv2(url: str):
    try:
        with requests.get(url, stream=True, timeout=DOWNLOAD_TIMEOUT) as response:
            if response.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Image download failed (HTTP {response.status_code})")

            content_type = (response.headers.get("content-type") or "").lower()
            if content_type and not content_type.startswith("image/"):
                raise HTTPException(status_code=400, detail="URL did not return an image")

            buffer = bytearray()
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                buffer.extend(chunk)
                if len(buffer) > MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail="Image exceeds the size limit")
    except HTTPException:
        raise
    except requests.RequestException as exc:
        raise HTTPException(status_code=400, detail=f"Could not download image: {exc}") from exc

    image_bytes = np.frombuffer(bytes(buffer), dtype=np.uint8)
    image = cv2.imdecode(image_bytes, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Invalid image stream")
    return image


def enhance_lighting(image):
    """Lift shadows for dim event photos before a second detection attempt."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    merged = cv2.merge((clahe.apply(l_channel), a_channel, b_channel))
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def represent(image, detector: str):
    return DeepFace.represent(
        img_path=image,
        model_name=MODEL_NAME,
        detector_backend=detector,
        enforce_detection=True,
        align=True,
    )


def extract_from_image(image):
    for detector in DETECTORS:
        try:
            faces = represent(image, detector)
            if faces:
                return faces
        except Exception:
            continue

    # Last attempt: brighten the frame and use the strongest detector.
    try:
        return represent(enhance_lighting(image), "retinaface")
    except Exception:
        return []


@app.get("/")
def root():
    return {"service": "snapsync-face-service", "model": MODEL_NAME, "status": "ok"}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "dimension": EMBEDDING_DIMENSION,
        "detectors": DETECTORS,
        "api_key_required": bool(API_KEY),
    }


@app.post("/warmup")
def warmup(_: None = Depends(require_api_key)):
    try:
        DeepFace.build_model(MODEL_NAME)
        return {"status": "warm", "model": MODEL_NAME}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/extract-embeddings")
def extract_embeddings(payload: ImageRequest, _: None = Depends(require_api_key)):
    image = download_image_to_cv2(str(payload.image_url))
    raw_faces = extract_from_image(image)

    extracted_faces = []
    for face in raw_faces:
        embedding = face.get("embedding")
        if not embedding or len(embedding) != EMBEDDING_DIMENSION:
            continue
        extracted_faces.append(
            {
                "embedding": embedding,
                "box": face.get("facial_area"),
            }
        )

    return {"faces": extracted_faces, "model": MODEL_NAME}


@app.on_event("startup")
def warm_model_on_startup():
    # Building the recognition model up front removes a slow first-request
    # penalty after a cold start. Detector weights still download on demand.
    try:
        DeepFace.build_model(MODEL_NAME)
        print(f"[startup] Loaded {MODEL_NAME} ({EMBEDDING_DIMENSION}d)")
    except Exception as exc:  # pragma: no cover - best effort warmup
        print(f"[startup] Could not preload {MODEL_NAME}: {exc}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
