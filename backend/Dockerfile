# Backend Python container
FROM python:3.11-slim

WORKDIR /app

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        gcc \
        git \
        python3-dev \
        libffi-dev \
        && rm -rf /var/lib/apt/lists/*
RUN pip install --upgrade pip setuptools
RUN pip install --no-cache-dir torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu

RUN git clone https://github.com/snakers4/silero-vad.git /app/silero-vad

# Install Silero VAD in editable mode
RUN pip install -e /app/silero-vad

# Install dependencies
COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

# Copy app code
COPY app.py .
COPY notes_manager.py .

# Expose ports for WebSocket (8765) and Flask (8000)
EXPOSE 8765

CMD ["python", "app.py"]
