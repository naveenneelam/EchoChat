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
  BarChart2
} from 'lucide-react';
import Visualizer from './components/Visualizer';
import SettingsModal from './components/SettingsModal';
import { AppConfig, ConnectionStatus, TranscriptMessage, Theme } from './types';
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [vadActive, setVadActive] = useState(false);
  
  // Visualization State
  const [vizMode, setVizMode] = useState<'frequency' | 'waveform'>('frequency');
  // NOTE: vizData state removed for performance. Visualizer now reads directly from AnalyserNode.

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
    const message = event.data;
    setTranscripts(prev => [...prev, {
          id: Date.now().toString(),
          text: message,
          sender: 'system',
          timestamp: Date.now(),
          isFinal: true
        }]);
    if (typeof message === 'string') {      
      if (message.startsWith('VOICE FEEDBACK:')) {
        const text = message.replace('VOICE FEEDBACK:', '').trim();
        speak(text);
        // Add to transcript as system
        setTranscripts(prev => [...prev, {
          id: Date.now().toString(),
          text: text,
          sender: 'system',
          timestamp: Date.now(),
          isFinal: true
        }]);
      } else if (message.startsWith('TRANSCRIPTION:')) {
        const text = message.replace('TRANSCRIPTION:', '').trim();
        // Add to transcript as user
        setTranscripts(prev => [...prev, {
          id: Date.now().toString(),
          text: text,
          sender: 'user',
          timestamp: Date.now(),
          isFinal: true
        }]);
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
          // We don't force sampleRate here because many browsers/devices don't support 16000 hardware rate.
          // We handle downsampling manually.
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
        setStatus(ConnectionStatus.CONNECTED);
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
    transcriptsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  return (
    <div className={`min-h-screen flex flex-col ${theme === 'dark' ? 'bg-dark-950 text-white' : 'bg-gray-50 text-gray-900'}`}>
      
      {/* HEADER */}
      <header className="px-6 py-4 flex items-center justify-between border-b border-gray-200 dark:border-dark-800 bg-white/50 dark:bg-dark-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-600 rounded-lg">
            <Activity className="text-white w-6 h-6" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">VAD & Whisper</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">Real-time ASR Stream</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium border ${
            status === ConnectionStatus.CONNECTED 
              ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800' 
              : status === ConnectionStatus.CONNECTING
              ? 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800'
              : status === ConnectionStatus.ERROR
              ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800'
              : 'bg-gray-100 text-gray-600 border-gray-200 dark:bg-dark-800 dark:text-gray-400 dark:border-dark-700'
          }`}>
            {status === ConnectionStatus.CONNECTED ? <Wifi size={14}/> : <WifiOff size={14}/>}
            <span className="uppercase tracking-wider">{status}</span>
          </div>

          <button 
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-dark-800 transition-colors"
          >
            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
          </button>
        </div>
      </header>

      {/* MAIN CONTENT */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* LEFT COLUMN: Visuals & Controls */}
        <div className="flex flex-col gap-6">
          
          {/* Visualizer Card */}
          <div className="flex-1 bg-white dark:bg-dark-900 rounded-2xl p-8 shadow-sm border border-gray-200 dark:border-dark-800 flex flex-col items-center justify-center relative overflow-hidden group">
             {/* Info overlay */}
            <div className="absolute top-4 left-4 z-10">
              <span className={`text-xs font-mono px-2 py-1 rounded ${vadActive ? 'bg-primary-500 text-white' : 'bg-gray-200 dark:bg-dark-800 text-gray-500'}`}>
                {vadActive ? 'VAD ACTIVE' : 'SILENCE'}
              </span>
            </div>

            {/* Viz Toggle */}
            <div className="absolute top-4 right-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                    onClick={toggleVizMode}
                    className="p-2 rounded-lg bg-gray-100 dark:bg-dark-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-dark-700 transition-colors"
                    title={`Switch to ${vizMode === 'frequency' ? 'Waveform' : 'Frequency'} view`}
                >
                    {vizMode === 'frequency' ? <Waves size={16} /> : <BarChart2 size={16} />}
                </button>
            </div>

            <Visualizer 
              isRecording={status === ConnectionStatus.CONNECTED} 
              analyser={analyserRef.current}
              vadActive={vadActive}
              mode={vizMode}
            />
            
            <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400 max-w-xs">
              {status === ConnectionStatus.CONNECTED 
                ? "Listening... Speak now. Pausing will trigger processing."
                : "Ready to connect. Ensure your Python backend is running."}
            </p>
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-4">
             {/* Error Message Box */}
            {status === ConnectionStatus.ERROR && errorMessage && (
                <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                    <div className="p-1 bg-red-100 dark:bg-red-800/50 rounded-full text-red-600 dark:text-red-200 shrink-0">
                        <AlertCircle size={18} />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-red-800 dark:text-red-200">Connection Failed</h3>
                        <p className="text-xs text-red-600 dark:text-red-300 mt-1 leading-relaxed">
                            {errorMessage}
                        </p>
                    </div>
                </div>
            )}

            <div className="bg-white dark:bg-dark-900 rounded-2xl p-6 shadow-sm border border-gray-200 dark:border-dark-800 flex items-center justify-between">
                <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-3 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-dark-800 rounded-xl transition-all"
                disabled={status === ConnectionStatus.CONNECTED}
                >
                <Settings size={24} />
                </button>

                <button
                onClick={toggleRecording}
                className={`relative group px-8 py-4 rounded-2xl flex items-center gap-3 font-bold text-lg transition-all transform active:scale-95 shadow-lg ${
                    status === ConnectionStatus.CONNECTED 
                    ? 'bg-red-500 hover:bg-red-600 text-white shadow-red-500/30' 
                    : 'bg-primary-600 hover:bg-primary-500 text-white shadow-primary-500/30'
                }`}
                >
                {status === ConnectionStatus.CONNECTED ? (
                    <>
                    <Square fill="currentColor" size={20} />
                    <span>Stop</span>
                    </>
                ) : (
                    <>
                    <Mic fill="currentColor" size={20} />
                    <span>Start Recording</span>
                    </>
                )}
                </button>
                
                <div className="w-12"></div> {/* Spacer for symmetry */}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Transcript */}
        <div className="bg-white dark:bg-dark-900 rounded-2xl shadow-sm border border-gray-200 dark:border-dark-800 flex flex-col overflow-hidden h-[500px] md:h-auto">
          <div className="p-4 border-b border-gray-200 dark:border-dark-800 flex items-center gap-2">
            <MessageSquare size={18} className="text-primary-500" />
            <h2 className="font-semibold">Live Transcript</h2>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/50 dark:bg-dark-950/50">
            {transcripts.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 opacity-60">
                <p>No speech detected yet.</p>
              </div>
            )}
            
            {transcripts.map((msg) => (
              <div 
                key={msg.id} 
                className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`max-w-[80%] px-4 py-3 rounded-2xl shadow-sm ${
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
            <div ref={transcriptsEndRef} />
          </div>
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
