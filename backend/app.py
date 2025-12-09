import asyncio
import websockets
import base64
import wave
import os
import re
import json
import time
import torch
import numpy as np
from flask import Flask, send_from_directory
from threading import Thread
import io
import onnx_asr
import aiohttp  # Changed for async HTTP requests
import notes_manager
from json_repair import repair_json
import logging
from datetime import datetime
from dataclasses import dataclass
from typing import Optional, Dict, Any, List
from collections import defaultdict
import uuid

# === Configuration ===
API_URL = "http://localhost:11434/api/generate"
OUTPUT_DIR = "output_files"
CACHE_DIR = "cache"
LOG_DIR = "logs"
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

# === Logging Setup ===
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, 'server.log')),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# === Data Classes ===
@dataclass
class SessionData:
    """Store session-specific data"""
    session_id: str
    audio_buffer: bytearray = None
    silent_frame_count: int = 0
    speech_frame_count: int = 0
    is_speaking: bool = False
    transcriptions: List[str] = None
    last_activity: float = None
    processing_task: Optional[asyncio.Task] = None
    
    def __post_init__(self):
        if self.audio_buffer is None:
            self.audio_buffer = bytearray()
        if self.transcriptions is None:
            self.transcriptions = []
        if self.last_activity is None:
            self.last_activity = time.time()

# === Global State ===
sessions: Dict[str, SessionData] = {}
MODEL = None
VAD_MODEL = None
VAD_THRESHOLD = 0.5
SAMPLE_RATE = 16000
FRAME_SIZE_SAMPLES = 512
CHUNK_SIZE = FRAME_SIZE_SAMPLES * 2
PAUSE_THRESHOLD_FRAMES = 60
MIN_SPEECH_FRAMES = 60

# === Flask App for Status Endpoint ===
app = Flask(__name__)

@app.route('/status')
def status():
    """Health check endpoint"""
    return {
        'status': 'running',
        'sessions': len(sessions),
        'timestamp': datetime.now().isoformat()
    }

@app.route('/logs')
def get_logs():
    """Get recent logs"""
    log_file = os.path.join(LOG_DIR, 'server.log')
    if os.path.exists(log_file):
        with open(log_file, 'r') as f:
            lines = f.readlines()[-100:]  # Last 100 lines
        return {'logs': lines}
    return {'logs': []}

def run_flask():
    """Run Flask server in background"""
    app.run(host='0.0.0.0', port=5000, debug=False)

# === Model Loading ===
async def load_models():
    """Async model loading"""
    global MODEL, VAD_MODEL
    
    try:
        logger.info("Loading ASR model...")
        MODEL = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3")
        logger.info("ASR model loaded successfully")
        
        logger.info("Loading Silero VAD model...")
        torch.backends.nnpack.enabled = False
        
        VAD_MODEL, _ = torch.hub.load(
            repo_or_dir='snakers4/silero-vad',
            model='silero_vad',
            force_reload=False,
            trust_repo=True
        )
        VAD_MODEL.eval()
        logger.info("Silero VAD model loaded successfully")
        
    except Exception as e:
        logger.error(f"Error loading models: {e}")
        raise

# === Async AI Query ===
async def query_ai_async(prompt: str, session_id: str) -> Dict[str, Any]:
    """Make async API call to AI model"""
    async with aiohttp.ClientSession() as session:
        payload = {
            "model": "gemma3:12b",
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.7,
                "top_p": 0.9,
                "max_tokens": 500
            }
        }
        
        try:
            async with session.post(API_URL, json=payload, timeout=30) as response:
                if response.status == 200:
                    data = await response.json()
                    return {
                        'success': True,
                        'response': data.get("response", ""),
                        'session_id': session_id
                    }
                else:
                    error_text = await response.text()
                    return {
                        'success': False,
                        'error': f"HTTP {response.status}: {error_text}",
                        'session_id': session_id
                    }
        except asyncio.TimeoutError:
            return {
                'success': False,
                'error': "AI query timeout",
                'session_id': session_id
            }
        except Exception as e:
            return {
                'success': False,
                'error': f"AI query failed: {str(e)}",
                'session_id': session_id
            }

# === Enhanced Prompt Template ===
PROMPT_TEMPLATE = """
You are a text intent and context classifier for a personal note manager.

Analyze the user's instruction and produce structured JSON with these fields:
1. **intent**: Primary purpose (take_notes, manage_tasks, update_info, remove_notes, read_notes, search_notes, categorize)
2. **context**: Subject/category (linux, electronics, todolist, ai, finance, general, work, personal)
3. **action**: Specific operation (insert, append, update, delete, read, search, tag, archive)
4. **text**: Clean, organized note content
5. **metadata**: Optional dict with tags, priority, due_date if mentioned
6. **confidence**: Your confidence score (0-1)

Rules for text formatting:
- Convert verbal lists to bullet points
- Summarize long content
- Preserve technical details
- Use consistent terminology
- Add timestamps if time-sensitive

Example output format:
{{
  "intent": "take_notes",
  "context": "linux",
  "action": "insert",
  "text": ["chmod command usage and syntax"],
  "metadata": {{"tags": ["commands", "permissions"]}},
  "confidence": 0.95
}}

Now analyze: "{text}"

Return ONLY valid JSON:
"""

# === Audio Processing ===
async def save_audio_segment(audio_bytes: bytes, sample_rate: int, session_id: str) -> str:
    """Save audio segment to file and return path"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{session_id}_{timestamp}.wav"
    filepath = os.path.join(OUTPUT_DIR, filename)
    
    with wave.open(filepath, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_bytes)
    
    logger.info(f"Audio saved: {filename} for session {session_id}")
    return filepath

async def transcribe_audio(filepath: str, session_id: str) -> str:
    """Transcribe audio file using ASR model"""
    try:
        if MODEL is None:
            raise ValueError("ASR model not loaded")
        
        text = MODEL.recognize(filepath)
        logger.info(f"Transcription for session {session_id}: {text[:50]}...")
        
        # Clean up file
        try:
            os.remove(filepath)
        except OSError as e:
            logger.warning(f"Could not delete {filepath}: {e}")
        
        return text.strip()
    except Exception as e:
        logger.error(f"Transcription failed for session {session_id}: {e}")
        return ""

# === JSON Processing ===
async def process_transcription(text: str, session_id: str, websocket) -> Dict[str, Any]:
    """Process transcription through AI and notes manager"""
    try:
        # Send immediate acknowledgment
        await websocket.send(json.dumps({
            "type": "PROCESSING",
            "message": "Processing your request...",
            "session_id": session_id,
            "timestamp": time.time()
        }))
        
        # Create enhanced prompt
        prompt = PROMPT_TEMPLATE.format(text=text)
        
        # Async AI query
        ai_result = await query_ai_async(prompt, session_id)
        
        if not ai_result['success']:
            raise ValueError(ai_result.get('error', 'AI query failed'))
        
        # Clean and parse JSON
        ai_response = ai_result['response']
        cleaned = re.sub(r'[^\x20-\x7E\n\r\t]+', '', ai_response)
        clean_str = cleaned.replace("```json", "").replace("```", "").strip()
        
        # Try to repair JSON
        try:
            repaired_json = repair_json(clean_str)
            data = json.loads(repaired_json)
        except json.JSONDecodeError:
            # Fallback: extract JSON using regex
            json_match = re.search(r'\{.*\}', clean_str, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
            else:
                raise ValueError("Could not parse JSON from AI response")
        
        # Validate required fields
        required_fields = ['intent', 'context', 'action', 'text']
        for field in required_fields:
            if field not in data:
                data[field] = ""
        
        # Process with notes manager
        if data["intent"] in ["take_notes", "manage_tasks", "update_info"]:
            text_content = data["text"]
            if isinstance(text_content, list):
                formatted_text = "\n".join(f"- {item.strip()}" for item in text_content)
            else:
                formatted_text = str(text_content).strip()
            
            # Async notes processing
            result = await asyncio.to_thread(
                notes_manager.process_instruction,
                data["context"],
                data["action"],
                formatted_text,
                data.get("metadata", {})
            )
            
            data["notes_result"] = result
        
        return data
        
    except Exception as e:
        logger.error(f"Processing failed for session {session_id}: {e}")
        return {
            "intent": "error",
            "context": "system",
            "action": "notify",
            "text": f"Processing error: {str(e)}",
            "error": str(e),
            "confidence": 0.0
        }

# === Feedback Generation ===
async def generate_feedback(processed_data: Dict[str, Any], session_id: str) -> str:
    """Generate user-friendly feedback based on processing results"""
    intent = processed_data.get("intent", "")
    context = processed_data.get("context", "")
    action = processed_data.get("action", "")
    
    feedback_templates = {
        "take_notes": "✅ Notes added to '{context}' category with {action} action.",
        "manage_tasks": "✅ Tasks updated in '{context}' list.",
        "update_info": "✅ Information updated in '{context}' section.",
        "remove_notes": "✅ Notes removed from '{context}' category.",
        "read_notes": "📖 Notes from '{context}' are ready for viewing.",
        "search_notes": "🔍 Search completed in '{context}' category.",
        "categorize": "🏷️  Content categorized under '{context}'."
    }
    
    default_feedback = "✅ Action completed successfully."
    
    feedback = feedback_templates.get(intent, default_feedback).format(
        context=context,
        action=action
    )
    
    # Add confidence indicator
    confidence = processed_data.get("confidence", 0)
    if confidence < 0.7:
        feedback += " (Low confidence - please verify)"
    
    return feedback

# === Session Management ===
def create_session(websocket) -> SessionData:
    """Create a new session for a WebSocket connection"""
    session_id = str(uuid.uuid4())[:8]
    session = SessionData(session_id=session_id)
    sessions[session_id] = session
    logger.info(f"Created new session: {session_id}")
    return session

def cleanup_session(session_id: str):
    """Clean up session resources"""
    if session_id in sessions:
        session = sessions[session_id]
        if session.processing_task and not session.processing_task.done():
            session.processing_task.cancel()
        del sessions[session_id]
        logger.info(f"Cleaned up session: {session_id}")

# === Main Audio Handler ===
async def audio_handler_silerovad(websocket):
    """Handle WebSocket audio stream with VAD"""
    if VAD_MODEL is None:
        logger.error("VAD model not loaded")
        await websocket.close()
        return
    
    session = create_session(websocket)
    
    try:
        logger.info(f"Client connected via WebSocket. Session: {session.session_id}")
        await websocket.send(json.dumps({
            "type": "CONNECTED",
            "session_id": session.session_id,
            "message": "Ready to receive audio"
        }))
        
        async for message in websocket:
            session.last_activity = time.time()
            
            if len(message) % CHUNK_SIZE != 0:
                logger.warning(f"Invalid chunk size: {len(message)}")
                continue
            
            for i in range(0, len(message), CHUNK_SIZE):
                frame_bytes = message[i:i + CHUNK_SIZE]
                
                # Convert to tensor for VAD
                audio_np = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                audio_tensor = torch.from_numpy(audio_np)
                
                # VAD inference
                with torch.no_grad():
                    speech_prob = VAD_MODEL(audio_tensor, SAMPLE_RATE).item()
                
                is_speech = speech_prob > VAD_THRESHOLD
                
                # VAD state machine
                if is_speech:
                    if not session.is_speaking:
                        logger.info(f"Speech started in session {session.session_id}")
                    session.is_speaking = True
                    session.silent_frame_count = 0
                    session.speech_frame_count += 1
                    session.audio_buffer.extend(frame_bytes)
                else:
                    if session.is_speaking:
                        session.silent_frame_count += 1
                        session.audio_buffer.extend(frame_bytes)
                        
                        if session.silent_frame_count >= PAUSE_THRESHOLD_FRAMES:
                            logger.info(f"Pause detected in session {session.session_id}")
                            session.is_speaking = False
                            
                            if session.speech_frame_count >= MIN_SPEECH_FRAMES:
                                # Process the audio segment
                                audio_bytes = bytes(session.audio_buffer)
                                
                                # Save and transcribe
                                filepath = await save_audio_segment(
                                    audio_bytes, SAMPLE_RATE, session.session_id
                                )
                                transcription = await transcribe_audio(
                                    filepath, session.session_id
                                )
                                
                                if transcription:
                                    # Store transcription
                                    session.transcriptions.append(transcription)
                                    
                                    # Send transcription to client
                                    await websocket.send(json.dumps({
                                        "type": "TRANSCRIPTION",
                                        "text": transcription,
                                        "session_id": session.session_id,
                                        "timestamp": time.time()
                                    }))
                                    
                                    # Check for command phrases
                                    command_phrases = [
                                        "confirm and submit",
                                        "process notes",
                                        "save that",
                                        "add to notes"
                                    ]
                                    
                                    if any(phrase in transcription.lower() for phrase in command_phrases):
                                        # Combine recent transcriptions
                                        recent_text = " ".join(session.transcriptions[-3:])
                                        
                                        # Start async processing
                                        session.processing_task = asyncio.create_task(
                                            process_and_feedback(recent_text, session.session_id, websocket)
                                        )
                                        session.transcriptions.clear()
                                
                            # Reset buffer
                            session.audio_buffer = bytearray()
                            session.silent_frame_count = 0
                            session.speech_frame_count = 0
    
    except websockets.exceptions.ConnectionClosedOK:
        logger.info(f"Client disconnected normally. Session: {session.session_id}")
    except Exception as e:
        logger.error(f"Error in session {session.session_id}: {e}")
    finally:
        cleanup_session(session.session_id)
        logger.info(f"Handler finished for session: {session.session_id}")

# === Async Processing Pipeline ===
async def process_and_feedback(text: str, session_id: str, websocket):
    """Complete async processing pipeline"""
    try:
        # Process transcription
        processed_data = await process_transcription(text, session_id, websocket)
        
        # Generate feedback
        feedback = await generate_feedback(processed_data, session_id)
        
        # Send comprehensive feedback
        await websocket.send(json.dumps({
            "type": "FEEDBACK",
            "message": feedback,
            "details": {
                "intent": processed_data.get("intent"),
                "context": processed_data.get("context"),
                "action": processed_data.get("action"),
                "confidence": processed_data.get("confidence", 0)
            },
            "session_id": session_id,
            "timestamp": time.time(),
            "success": True
        }))
        
        logger.info(f"Processing completed for session {session_id}: {feedback}")
        
    except Exception as e:
        logger.error(f"Feedback generation failed for session {session_id}: {e}")
        await websocket.send(json.dumps({
            "type": "ERROR",
            "message": f"Processing failed: {str(e)}",
            "session_id": session_id,
            "timestamp": time.time(),
            "success": False
        }))

# === Session Cleanup Task ===
async def session_cleanup_task():
    """Periodically clean up inactive sessions"""
    while True:
        await asyncio.sleep(300)  # Every 5 minutes
        current_time = time.time()
        inactive_sessions = []
        
        for session_id, session in list(sessions.items()):
            if current_time - session.last_activity > 600:  # 10 minutes inactivity
                inactive_sessions.append(session_id)
        
        for session_id in inactive_sessions:
            logger.info(f"Cleaning up inactive session: {session_id}")
            cleanup_session(session_id)

# === Main Server ===
async def main():
    """Main server function"""
    # Load models
    await load_models()
    
    # Start Flask in background
    flask_thread = Thread(target=run_flask, daemon=True)
    flask_thread.start()
    
    # Start session cleanup task
    cleanup_task = asyncio.create_task(session_cleanup_task())
    
    # Start WebSocket server
    HOST = "0.0.0.0"
    PORT = 8765
    
    async with websockets.serve(audio_handler_silerovad, HOST, PORT):
        logger.info(f"WebSocket Server started on ws://{HOST}:{PORT}")
        logger.info(f"Flask status endpoint: http://{HOST}:5000/status")
        
        try:
            await asyncio.Future()  # Run forever
        except KeyboardInterrupt:
            logger.info("Server shutting down...")
        finally:
            cleanup_task.cancel()
            # Clean up all sessions
            for session_id in list(sessions.keys()):
                cleanup_session(session_id)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("\nServer shut down by user")
    except Exception as e:
        logger.error(f"Server crashed: {e}")
        raise