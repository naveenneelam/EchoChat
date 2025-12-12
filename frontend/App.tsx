import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Mic, 
  Square, 
  Settings, 
  Moon, 
  Sun, 
  Wifi, 
  WifiOff, 
  Activity,
  MessageSquare,
  AlertCircle,
  Waves,
  BarChart2,
  Loader2,
  Sparkles,
  AudioLines
} from 'lucide-react';
import Visualizer from './components/Visualizer';
import SettingsModal from './components/SettingsModal';
import { AppConfig, ConnectionStatus, TranscriptMessage, Theme, ProcessStatus } from './types';
import { floatTo16BitPCM, calculateRMS, downsampleBuffer } from './utils/audioUtils';

// Helper to determine default protocol
// Defaulting to ws:// as requested for local insecure dev environments
const getInitialUrl = () => {
  const defaultAddr = 'localhost:8765';
  return `ws://${defaultAddr}`;
};

// Constants matching the provided reference logic
const DEFAULT_CONFIG: AppConfig = {
  wsUrl: getInitialUrl(),
  sampleRate: 16000,
  frameDurationMs: 32,
  pauseThreshold: 500, // 500ms pause to consider end of utterance
  silenceThreshold: 0.01 // Simple amplitude threshold for client-side VAD visual
};

const BROWSER_BUFFER_SIZE = 512;
const TARGET_SAMPLE_RATE = 16000;

function App() {
  // --- State ---
  const [theme, setTheme] = useState<Theme>('dark');
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [transcripts, setTranscripts] = useState<TranscriptMessage[]>([]);
  const [processStatus, setProcessStatus] = useState<ProcessStatus>('idle');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [vadActive, setVadActive] = useState(false);

  // Visualization State
  const [vizMode, setVizMode] = useState<'frequency' | 'waveform'>('frequency');

  // --- Refs ---
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioQueueRef = useRef<number[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const transcriptsEndRef = useRef<HTMLDivElement>(null);

  // Keep track of current viz mode in ref for the audio process loop to avoid stale closures
  const vizModeRef = useRef<'frequency' | 'waveform'>('frequency');
  useEffect(() => { vizModeRef.current = vizMode; }, [vizMode]);

  // --- Theme Management ---
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // --- Speech Synthesis Setup ---
  useEffect(() => {
    const u = new SpeechSynthesisUtterance();
    u.lang = "en-US";
    u.rate = 1;
    u.pitch = 1;
    u.volume = 1;
    utteranceRef.current = u;
  }, []);

  const speak = (text: string) => {
    if (!utteranceRef.current) return;

    // Cancel any current speaking to avoid queue buildup
    window.speechSynthesis.cancel();

    utteranceRef.current.text = text;
    window.speechSynthesis.speak(utteranceRef.current);
  };

  // --- WebSocket Handling ---
  const handleWebSocketMessage = useCallback((event: MessageEvent) => {
    const rawData = event.data;

    try {
      // Parse JSON messages
      const data = JSON.parse(rawData);

      // Normalize type to uppercase to avoid case sensitivity issues
      // e.g. 'transcription_started' -> 'TRANSCRIPTION_STARTED'
      const msgType = (data.type || '').toUpperCase();

      console.log("WS Message:", msgType, data);

      switch (msgType) {
        case 'CONNECTED':
        case 'CONNECTION_ESTABLISHED':
          setStatus(ConnectionStatus.CONNECTED);
          setProcessStatus('idle');
          break;

        // Start of speech / VAD trigger
        case 'TRANSCRIPTION_STARTED':
        case 'SPEECH_START':
        case 'VAD_START':
        case 'LISTENING':
          setProcessStatus('transcribing');
          break;

        // User speech converted to text
        case 'TRANSCRIPTION_COMPLETED':
        case 'TRANSCRIPTION':
        case 'USER_TRANSCRIPT':
          const userText = data.text?.trim();
          if (userText) {
            setTranscripts(prev => [...prev, {
              id: (data.session_id || '') + Date.now().toString(),
              text: userText,
              sender: 'user',
              timestamp: data.timestamp ? data.timestamp * 1000 : Date.now(),
              isFinal: true
            }]);
          }
          // After transcription, we go to idle, unless processing started comes immediately.
          setProcessStatus('idle');
          break;

        // LLM / AI processing start
        case 'PROCESSING_STARTED':
        case 'PROCESSING_START':
        case 'THINKING':
          setProcessStatus('processing');
          break;

        // LLM / AI response
        case 'PROCESSING_COMPLETED':
        case 'SYSTEM_RESPONSE':
        case 'VOICE_FEEDBACK':
        case 'AI_RESPONSE':
          const systemText = (data.text || data.message || '').trim();
          if (systemText) {
            stopRecording();
            speak(systemText);
            startRecording();
            setTranscripts(prev => [...prev, {
              id: Date.now().toString(),
              text: systemText,
              sender: 'system',
              timestamp: Date.now(),
              isFinal: true
            }]);
          }
          setProcessStatus('idle');
          break;

        default:
          console.log("Received unhandled message type:", msgType);
          break;
      }

    } catch (e) {
      // --- Fallback: Legacy Plain Text Protocol ---
      if (typeof rawData === 'string') {
        const textData = rawData.trim();
        if (textData.startsWith('VOICE FEEDBACK:')) {
          const text = textData.replace('VOICE FEEDBACK:', '').trim();
            stopRecording();
            speak(text);
            startRecording();
          setTranscripts(prev => [...prev, {
            id: Date.now().toString(),
            text: text,
            sender: 'system',
            timestamp: Date.now(),
            isFinal: true
          }]);
          setProcessStatus('idle');
        } else if (textData.startsWith('TRANSCRIPTION:')) {
          const text = textData.replace('TRANSCRIPTION:', '').trim();
          setTranscripts(prev => [...prev, {
            id: Date.now().toString(),
            text: text,
            sender: 'user',
            timestamp: Date.now(),
            isFinal: true
          }]);
          setProcessStatus('idle');
        } else if (textData.includes('started')) {
           // Heuristic for plain text status messages if any
           if (textData.toLowerCase().includes('transcription')) setProcessStatus('transcribing');
           if (textData.toLowerCase().includes('processing')) setProcessStatus('processing');
        }
      }
    }
  }, []);

  const cleanupAudio = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }
    audioQueueRef.current = [];
    setVadActive(false);
    setProcessStatus('idle');
  };

  const cleanupWS = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus(ConnectionStatus.DISCONNECTED);
  };

  const stopRecording = () => {
    cleanupAudio();
    cleanupWS();
  };

  const startRecording = async () => {
    setErrorMessage(null);
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setProcessStatus('idle');

      // 1. Browser Capability Check
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          "Microphone access is not supported in this context. Browsers require HTTPS or 'localhost' to access the microphone."
        );
      }

      // 2. Get Mic Access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      streamRef.current = stream;

      // 3. Setup Audio Context
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass(); // Let it use default system rate
      audioContextRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const inputSampleRate = ctx.sampleRate;

      console.log(`Audio Context initialized at ${inputSampleRate}Hz. Target is ${TARGET_SAMPLE_RATE}Hz`);

      // Analyser for Visualization
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024; // Increased for better resolution
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;
      source.connect(analyser);

      // Processor for PCM streaming
      const processor = ctx.createScriptProcessor(BROWSER_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;

      // VAD / Frame calculations
      const VAD_SAMPLES_PER_FRAME = TARGET_SAMPLE_RATE * config.frameDurationMs / 1000; // 512

      processor.onaudioprocess = (e) => {
        // PERFORMANCE FIX: Visualization data is no longer extracted here.
        // The Visualizer component reads directly from analyserRef.current in a RAF loop.

        // PCM Streaming Logic
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);

          // Simple Client-Side VAD for Visualization (Badge only)
          const rms = calculateRMS(inputData);
          const isSpeech = rms > config.silenceThreshold;

          // Only update React state if it changes to avoid thrashing
          setVadActive(prev => (prev !== isSpeech ? isSpeech : prev));

          // Downsampling Logic
          let processedData: Float32Array;
          if (inputSampleRate !== TARGET_SAMPLE_RATE) {
            processedData = downsampleBuffer(inputData, inputSampleRate, TARGET_SAMPLE_RATE);
          } else {
            processedData = inputData;
          }

          // Buffer and Send
          // Explicitly cast to number[] to fix TS type inference issues
          audioQueueRef.current.push(...(Array.from(processedData) as number[]));

          while (audioQueueRef.current.length >= VAD_SAMPLES_PER_FRAME) {
            const frame = audioQueueRef.current.slice(0, VAD_SAMPLES_PER_FRAME);
            audioQueueRef.current = audioQueueRef.current.slice(VAD_SAMPLES_PER_FRAME);

            const pcmBuffer = floatTo16BitPCM(new Float32Array(frame));

            try {
                wsRef.current.send(pcmBuffer);
            } catch(err) {
                console.error("Error sending frame:", err);
            }
          }
        }
      };

      // Connect Audio Graph
      source.connect(processor);
      processor.connect(ctx.destination);

      // 4. Connect WebSocket
      const connectionUrl = config.wsUrl;
      console.log("Connecting to WebSocket:", connectionUrl);

      const ws = new WebSocket(connectionUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log("WebSocket connected");
        // Status will be set to CONNECTED when 'CONNECTED' message is received
      };

      ws.onmessage = handleWebSocketMessage;

      ws.onerror = (error) => {
        console.error("WS Error", error);
        setStatus(ConnectionStatus.ERROR);

        // Try to derive a helpful message
        let msg = "Connection failed. Check server status and URL.";
        if (window.location.protocol === 'https:' && connectionUrl.startsWith('ws://')) {
          msg += " (Note: Browsers often block insecure ws:// from https:// pages)";
        }

        if (!errorMessage) {
            setErrorMessage(msg);
        }
        cleanupAudio(); // Stop recording on error
      };

      ws.onclose = (event) => {
        console.log(`WebSocket closed: Code ${event.code}, Reason: ${event.reason}`);
        // Only set disconnected if we didn't just error out
        setStatus((prev) => prev === ConnectionStatus.ERROR ? prev : ConnectionStatus.DISCONNECTED);
        cleanupAudio();
      };

      wsRef.current = ws;

    } catch (err: any) {
      console.error("Setup Error", err);
      setStatus(ConnectionStatus.ERROR);

      // Formatting the error message nicely
      let msg = err.message || "Unknown error occurred during setup";
      if (err.name === 'NotAllowedError') {
        msg = "Microphone permission denied. Please allow access in browser settings.";
      } else if (err.name === 'NotFoundError') {
        msg = "No microphone found.";
      }

      setErrorMessage(msg);
    }
  };

  const toggleRecording = () => {
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const toggleVizMode = () => {
      setVizMode(prev => prev === 'frequency' ? 'waveform' : 'frequency');
  };

  // Scroll to bottom of transcript
  useEffect(() => {
    // Use 'nearest' to prevent the viewport from jumping around on mobile
    transcriptsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [transcripts, processStatus]);

  return (
    // Outer container: Fixed viewport height to prevent whole-page scrolling
    <div className={`h-[100dvh] flex flex-col ${theme === 'dark' ? 'bg-dark-950 text-white' : 'bg-gray-50 text-gray-900'} overflow-hidden`}>

      {/* HEADER - Fixed Height */}
      <header className="flex-none px-4 py-3 md:px-6 md:py-4 flex items-center justify-between border-b border-gray-200 dark:border-dark-800 bg-white/50 dark:bg-dark-900/50 backdrop-blur-md z-20">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="p-1.5 md:p-2 bg-primary-600 rounded-lg">
            <Activity className="text-white w-5 h-5 md:w-6 md:h-6" />
          </div>
          <div>
            <h1 className="font-bold text-base md:text-lg leading-tight">VAD & Whisper</h1>
            <p className="hidden md:block text-xs text-gray-500 dark:text-gray-400">Real-time ASR Stream</p>
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3">
          <div className={`flex items-center gap-2 px-2 py-1 md:px-3 rounded-full text-[10px] md:text-xs font-medium border ${
            status === ConnectionStatus.CONNECTED
              ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800'
              : status === ConnectionStatus.CONNECTING
              ? 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800'
              : status === ConnectionStatus.ERROR
              ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800'
              : 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-dark-800 dark:text-gray-400 dark:border-dark-700'
          }`}>
            {status === ConnectionStatus.CONNECTED ? <Wifi size={12}/> : <WifiOff size={12}/>}
            <span className="uppercase tracking-wider hidden sm:inline">{status}</span>
          </div>

          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-1.5 md:p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-dark-800 transition-colors"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      {/* MAIN CONTENT - Mobile Sandwich Layout / Desktop Grid Layout */}
      <main className="flex-1 min-h-0 w-full max-w-7xl mx-auto p-3 md:p-6 grid grid-cols-1 md:grid-cols-2 grid-rows-[auto_1fr_auto] md:grid-rows-[1fr_auto] gap-3 md:gap-6">

        {/*
           VISUALIZER PANEL
           Mobile: Order 1 (Top). Fixed Height (~140px).
           Desktop: Col 1, Row 1 (Left Top). Expands.
        */}
        <div className="order-1 md:order-none md:col-start-1 md:row-start-1 bg-white dark:bg-dark-900 rounded-2xl p-2 md:p-4 shadow-sm border border-gray-200 dark:border-dark-800 flex flex-col items-center justify-center relative overflow-hidden h-36 md:h-auto shrink-0 group">
             {/* Info overlay */}
            <div className="absolute top-3 left-3 z-10">
              <span className={`text-[10px] md:text-xs font-mono px-2 py-0.5 rounded ${vadActive ? 'bg-primary-500 text-white' : 'bg-gray-200 dark:bg-dark-800 text-gray-500'}`}>
                {vadActive ? 'VAD' : 'SILENCE'}
              </span>
            </div>

            <div className="absolute top-3 right-3 z-10 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                <button
                    onClick={toggleVizMode}
                    className="p-1.5 md:p-2 rounded-lg bg-gray-100 dark:bg-dark-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-dark-700 transition-colors"
                >
                    {vizMode === 'frequency' ? <Waves size={14} /> : <BarChart2 size={14} />}
                </button>
            </div>

            <div className="w-full h-full flex items-center justify-center">
                <Visualizer
                isRecording={status === ConnectionStatus.CONNECTED}
                analyser={analyserRef.current}
                vadActive={vadActive}
                mode={vizMode}
                />
            </div>

            <p className="hidden md:block mt-6 text-center text-sm text-gray-500 dark:text-gray-400 max-w-xs">
              {status === ConnectionStatus.CONNECTED
                ? "Listening... Speak now."
                : "Ready to connect."}
            </p>
        </div>

        {/*
           TRANSCRIPT PANEL
           Mobile: Order 2 (Middle). Fills remaining space. Scrolls internally.
           Desktop: Col 2, Row Span 2 (Right Side Full).
        */}
        <div className="order-2 md:order-none md:col-start-2 md:row-span-2 flex-1 min-h-0 bg-white dark:bg-dark-900 rounded-2xl shadow-sm border border-gray-200 dark:border-dark-800 flex flex-col overflow-hidden relative">
          <div className="p-3 md:p-4 border-b border-gray-200 dark:border-dark-800 flex items-center gap-2 flex-none bg-white/50 dark:bg-dark-900/50 backdrop-blur-sm z-10">
            <MessageSquare size={18} className="text-primary-500" />
            <h2 className="font-semibold text-sm md:text-base">Live Transcript</h2>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/50 dark:bg-dark-950/50 relative scroll-smooth overscroll-contain">
            {transcripts.length === 0 && processStatus === 'idle' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 opacity-60 pointer-events-none">
                <p>No speech detected yet.</p>
              </div>
            )}

            {transcripts.map((msg) => (
              <div
                key={msg.id}
                className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[85%] md:max-w-[80%] px-4 py-3 rounded-2xl shadow-sm ${
                  msg.sender === 'user'
                    ? 'bg-primary-600 text-white rounded-tr-sm'
                    : 'bg-white dark:bg-dark-800 border border-gray-100 dark:border-dark-700 text-gray-800 dark:text-gray-100 rounded-tl-sm'
                }`}>
                  <p className="text-sm leading-relaxed">{msg.text}</p>
                  <span className={`text-[10px] mt-1 block opacity-70 ${msg.sender === 'user' ? 'text-primary-100' : 'text-gray-400'}`}>
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}

            {processStatus === 'transcribing' && (
              <div className="flex w-full justify-end animate-in fade-in slide-in-from-bottom-2">
                <div className="max-w-[85%] md:max-w-[80%] px-4 py-3 rounded-2xl rounded-tr-sm bg-primary-600/90 text-white backdrop-blur-sm flex items-center gap-3 shadow-md border border-primary-500/20">
                    <div className="p-1.5 bg-primary-500/30 rounded-full animate-pulse">
                        <AudioLines size={18} className="text-white" />
                    </div>
                     <div className="flex items-center gap-1 h-3">
                        <div className="w-1 h-3 bg-white/80 rounded-full animate-[bounce_1s_infinite_0ms]"></div>
                        <div className="w-1 h-4 bg-white/80 rounded-full animate-[bounce_1s_infinite_200ms]"></div>
                        <div className="w-1 h-2 bg-white/80 rounded-full animate-[bounce_1s_infinite_400ms]"></div>
                     </div>
                </div>
              </div>
            )}

            {processStatus === 'processing' && (
              <div className="flex w-full justify-start animate-in fade-in slide-in-from-bottom-2">
                <div className="max-w-[85%] md:max-w-[80%] px-4 py-3 rounded-2xl rounded-tl-sm bg-white dark:bg-dark-800 border border-gray-100 dark:border-dark-700 text-gray-800 dark:text-gray-100 shadow-sm flex items-center gap-3">
                   <div className="p-1.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg">
                      <Sparkles size={16} className="animate-pulse" />
                   </div>
                   <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                      <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                      <span className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"></span>
                   </div>
                </div>
              </div>
            )}

            <div ref={transcriptsEndRef} />
          </div>
        </div>

        {/*
           CONTROLS PANEL
           Mobile: Order 3 (Bottom). Fixed Height.
           Desktop: Col 1, Row 2 (Left Bottom).
        */}
        <div className="order-3 md:order-none md:col-start-1 md:row-start-2 bg-white dark:bg-dark-900 rounded-2xl p-4 md:p-6 shadow-sm border border-gray-200 dark:border-dark-800 flex items-center justify-between shrink-0 z-20">
             {/* Error Message if any (absolute positioned to appear above buttons) */}
             {status === ConnectionStatus.ERROR && errorMessage && (
                <div className="absolute bottom-full left-0 right-0 mb-2 mx-4 p-3 bg-red-50 dark:bg-red-900/90 border border-red-200 dark:border-red-800 rounded-xl flex items-center gap-3 backdrop-blur-md shadow-lg animate-in fade-in slide-in-from-bottom-2 z-30">
                    <AlertCircle size={16} className="text-red-600 dark:text-red-200 shrink-0" />
                    <p className="text-xs text-red-600 dark:text-red-200 line-clamp-2">{errorMessage}</p>
                </div>
            )}

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-3 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-dark-800 rounded-xl transition-all"
              disabled={status === ConnectionStatus.CONNECTED}
            >
              <Settings size={22} />
            </button>

            <button
              onClick={toggleRecording}
              className={`flex-1 mx-4 relative group py-3 md:py-4 rounded-xl flex items-center justify-center gap-3 font-bold text-base md:text-lg transition-all transform active:scale-95 shadow-lg ${
                status === ConnectionStatus.CONNECTED
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/30'
                  : 'bg-primary-600 hover:bg-primary-500 text-white shadow-primary-500/30'
              }`}
            >
              {status === ConnectionStatus.CONNECTED ? (
                <>
                  <Square fill="currentColor" size={18} />
                  <span>Stop</span>
                </>
              ) : (
                <>
                  <Mic fill="currentColor" size={18} />
                  <span>Start</span>
                </>
              )}
            </button>

            <div className="w-11"></div> {/* Spacer for symmetry with settings button */}
        </div>

      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={config}
        onSave={setConfig}
      />
    </div>
  );
}

export default App;