# SnapSync face service — deployable to Hugging Face Spaces (Docker).
FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/user \
    TF_CPP_MIN_LOG_LEVEL=3 \
    TF_ENABLE_ONEDNN_OPTS=0 \
    HF_HOME=/user/.cache/huggingface

# OpenCV / TensorFlow runtime libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /user/app

# Hugging Face Spaces runs containers as uid 1000; keep the home writable for
# DeepFace model weights.
RUN mkdir -p /user && chmod -R 777 /user

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Download the ArcFace weights at build time so the first guest request is fast.
RUN python -c "from deepface import DeepFace; DeepFace.build_model('ArcFace')" && \
    chmod -R 777 /user/.deepface /user/.cache 2>/dev/null || true

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7860/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
