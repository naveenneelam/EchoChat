# <img width="50" height="50" alt="ChatGPT Image Dec 11, 2025, 08_17_15 PM" src="https://github.com/user-attachments/assets/9dd5a0a4-82a8-41ae-b38b-66db74e608fe" />
**EchoChat**

**EchoChat** is a fully containerized, real-time **voice-driven note-taking and AI interaction system**.
It uses **ReactJS** (frontend), **Python FastAPI** (backend), **WebSockets** for live audio streaming, **ONNX Parakeet ASR** for speech-to-text, **Silero VAD** for voice activity detection, and **Ollama-powered local LLMs** for intent detection and action execution.

EchoChat allows users to capture audio through the microphone, view live multi-color waveform activity, generate accurate speech transcription, detect user intentions from the transcribed text, and trigger contextual actions—such as creating categorized notes—based on confirmed commands.

---

## **✨ Key Features**

### 🎙️ **Real-Time Voice Input**

* Capture audio directly from the browser microphone.
* Live voice segmentation using **Silero VAD**.
* Multi-color waveform visualization (silence / speech / processing / confirmation).

### 📝 **Accurate Speech Transcription**

* CPU-optimized **ONNX Parakeet ASR** model.
* Streaming transcription via WebSocket.
* Automatic punctuation and formatting.

### 🤖 **Local LLM-driven Action Engine**

* Powered by **Ollama** running local LLMs.
* Extracts:

    * Intent
    * Action
    * Category
    * Additional parameters (e.g., note contents)

### ✔️ **User-Confirmed Actions**

* Actions run **only when the user says a confirmation keyword**, e.g.:

    * **"confirm and submit"**
    * **"thats all"**
* Example:
  “Create a note in electronics category about Arduino sensors… **confirm and submit**”

### 🔌 **WebSocket Architecture**

* Low-latency interaction between React frontend and Python backend.
* Streams audio → processes → returns partial + final transcripts.
### 🔌 **ScreenShots**
<img width="720" height="624" alt="image" src="https://github.com/user-attachments/assets/f048cd70-90a9-46a1-be9c-0e35a98c4b19" />
<img width="720" height="618" alt="image" src="https://github.com/user-attachments/assets/af8b3750-1d91-450c-9d71-6151e7acb2b8" />


### 🐳 **Docker Compose Deployment**

* Fully isolated multi-container environment.
* Services:

    * `frontend` (React)
    * `backend` (FastAPI)

---

## **📁 Project Structure**

```
EchoChat/
│
├── frontend/              # ReactJS UI
│   ├── components/
│   ├── dist/
│   ├── node_modules/
│   ├── index.tsx
│   ├── index.html/
│   ├── .....
│   └── Dockerfile
│
├── backend/               # Python FastAPI backend
│   ├── app.py
│   ├── requirements.txt
│   └── Dockerfile
|
├── docker-compose.yml
└── README.md
```

---

## **🚀 Getting Started**

### **1️⃣ Prerequisites**

* Docker & Docker Compose installed
* 4GB+ RAM recommended (for LLMs)
* Microphone permissions enabled in browser

---

## **2️⃣ Clone the Repository**

```bash
git clone https://github.com/<your-username>/EchoChat.git
cd EchoChat
```

---

## **3️⃣ Start the Stack**

```bash
docker compose up --build
```

---

## **4️⃣ Access the App**

* Frontend: **[http://localhost:81]**
* Ollama server (external + local): **[http://localhost:11434](http://localhost:11434)**

---

## **🧠 AI Components**

### **Speech-to-Text**

* Model: **ONNX Parakeet (CPU optimized)**
* Streaming inference
* Low latency even on low-end machines

### **Voice Activity Detection**

* **Silero VAD** identifies:

    * Speech vs silence
    * Threshold-based segmentation
    * Color-coded waveform display

### **LLM Intent Classification**

Using Ollama models (e.g., llama3, mistral, qwen), the system extracts:

| Field                    | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| **Intent**               | What the user wants (create_note, search, reminder, etc.) |
| **Category**             | e.g., electronics, personal, work                         |
| **Content**              | Actual note or command details                            |
| **Action Required?**     | Yes/No based on keywords                                  |
| **Confirmation Needed?** | Triggered when user says “confirm/submit”                 |

---

## **🧩 How It Works (Flow)**

### **1. User speaks**

⬇

### **2. Browser captures audio → streams via WebSocket**

⬇

### **3. Backend performs VAD + ASR transcription**

⬇

### **4. LLM analyzes transcript**

* Extracts intent
* Prepares actions
  ⬇

### **5. Action executed only after confirmation**

⬇

### **6. Result returned to frontend**

---

## **🧪 Example User Scenario**

**User:**
“Make a note about Arduino sensors under electronics. I need this for tomorrow.
… confirm”

**Detected by system:**

* Intent: `create_note`
* Category: `electronics`
* Content: "Arduino sensors… tomorrow"
* Action: save note
* Status: executed after “confirm”

---

## **📦 Docker Compose Overview**

```yaml
services:
  backend:
    build: ./backend
    ports:
      - "8765:8765"   
    environment:
      - stt-network
    networks:
      - stt-network
    volumes:
      - ./output_files:/app/output_files
      - ./notes:/app/notes      
  frontend:
    build: ./frontend
    ports:
      - "81:80"
    depends_on:
      - backend
    networks:
      - stt-network

networks:
  stt-network:
    driver: bridge

```

---

## **👨‍💻 Development Mode**

Start frontend:

```bash
cd frontend
npm install
npm start
```

Start backend:

```bash
cd backend
pip install -r requirements.txt
python app.py
```

---

## **📜 Roadmap**

* [ ] Embed-based memory for persistent notes
* [ ] Multi-speaker segmentation
* [ ] Offline mode (service worker)
* [ ] Mobile PWA
* [ ] Add whisper.cpp as optional ASR backend

---

## **🛡️ License**

MIT License © 2025

---
