import os
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"

import cv2
import numpy as np
import requests
from deepface import DeepFace
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

app = FastAPI()

class ImageRequest(BaseModel):
    image_url: str

def download_image_to_cv2(url: str):
    try:
        response = requests.get(url, stream=True, timeout=15)
        if response.status_code != 200:
            raise HTTPException(status_code=400, detail=f"HTTP {response.status_code}")
        image_bytes = np.asarray(bytearray(response.raw.read()), dtype=np.uint8)
        img = cv2.imdecode(image_bytes, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image stream")
        return img
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def enhance_lighting(img):
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        cl = clahe.apply(l)
        limg = cv2.merge((cl, a, b))
        return cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)

@app.post("/extract-embeddings")
def extract_embeddings(payload: ImageRequest):
    img = download_image_to_cv2(payload.image_url)
    
    detectors = ["retinaface", "mtcnn", "ssd", "opencv"]
    embeddings_data = None
    
    for detector in detectors:
        try:
            embeddings_data = DeepFace.represent(
                img_path=img,
                model_name="ArcFace",
                detector_backend=detector,
                enforce_detection=True
            )
            if embeddings_data:
                break
        except Exception:
            continue
            
    if not embeddings_data:
        try:
            enhanced_img = enhance_lighting(img)
            embeddings_data = DeepFace.represent(
                img_path=enhanced_img,
                model_name="ArcFace",
                detector_backend="retinaface",
                enforce_detection=True
            )
        except Exception:
            return {"faces": []}
            
    extracted_faces = []
    for face in embeddings_data:
        extracted_faces.append({
            "embedding": face["embedding"],
            "box": face["facial_area"]
        })
        
    return {"faces": extracted_faces}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)