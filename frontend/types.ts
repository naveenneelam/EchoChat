export interface TranscriptMessage {
  id: string;
  text: string;
  sender: 'user' | 'system';
  timestamp: number;
  isFinal: boolean;
}

export interface AppConfig {
  wsUrl: string;
  sampleRate: number;
  frameDurationMs: number; // 32ms
  pauseThreshold: number; // Duration in ms to consider a pause
  silenceThreshold: number; // Amplitude threshold (0-1)
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export type ProcessStatus = 'idle' | 'transcribing' | 'processing';

export type Theme = 'light' | 'dark';