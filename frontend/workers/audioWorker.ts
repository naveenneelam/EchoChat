import { floatTo16BitPCM, downsampleBuffer } from '../utils/audioUtils';
import { AppConfig, WorkerCommand, WorkerEvent } from '../types';

let socket: WebSocket | null = null;
let config: AppConfig | null = null;
let audioBufferQueue: number[] = [];

// Constants needed for processing
const TARGET_SAMPLE_RATE = 16000;

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const { type } = e.data;

  switch (type) {
    case 'INIT':
      initialize(e.data.config);
      break;
    case 'STOP':
      cleanup();
      break;
    case 'AUDIO_DATA':
      processAudio(e.data.data, e.data.inputSampleRate);
      break;
  }
};

function postEvent(event: WorkerEvent) {
  self.postMessage(event);
}

function initialize(cfg: AppConfig) {
  cleanup(); // Ensure clean slate
  config = cfg;
  audioBufferQueue = [];

  try {
    socket = new WebSocket(config.wsUrl);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      postEvent({ type: 'WS_OPEN' });
    };

    socket.onmessage = (event) => {
      const message = event.data;
      if (typeof message === 'string') {
        if (message.startsWith('VOICE FEEDBACK:')) {
          const text = message.replace('VOICE FEEDBACK:', '').trim();
          postEvent({ type: 'TRANSCRIPT', text, sender: 'system' });
        } else if (message.startsWith('TRANSCRIPTION:')) {
          const text = message.replace('TRANSCRIPTION:', '').trim();
          postEvent({ type: 'TRANSCRIPT', text, sender: 'user' });
        }
      }
    };

    socket.onerror = (error) => {
      postEvent({ type: 'WS_ERROR', error: 'WebSocket connection failed' });
    };

    socket.onclose = (event) => {
      postEvent({ type: 'WS_CLOSE', code: event.code, reason: event.reason });
    };

  } catch (err: any) {
    postEvent({ type: 'WS_ERROR', error: err.message });
  }
}

function processAudio(inputData: Float32Array, inputSampleRate: number) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !config) return;

  // 1. Downsample if necessary
  let processedData: Float32Array;
  if (inputSampleRate !== TARGET_SAMPLE_RATE) {
    processedData = downsampleBuffer(inputData, inputSampleRate, TARGET_SAMPLE_RATE);
  } else {
    processedData = inputData;
  }

  // 2. Add to Queue
  // We use a simple array push here. For extremely high perf, a RingBuffer / CircularBuffer
  // with a fixed Float32Array would be better, but array push is sufficient for 16khz/mono.
  for (let i = 0; i < processedData.length; i++) {
    audioBufferQueue.push(processedData[i]);
  }

  // 3. Calculate VAD Frame Size
  const VAD_SAMPLES_PER_FRAME = Math.floor(TARGET_SAMPLE_RATE * config.frameDurationMs / 1000);

  // 4. Process chunks
  while (audioBufferQueue.length >= VAD_SAMPLES_PER_FRAME) {
    const frame = audioBufferQueue.slice(0, VAD_SAMPLES_PER_FRAME);
    audioBufferQueue = audioBufferQueue.slice(VAD_SAMPLES_PER_FRAME);

    const pcmBuffer = floatTo16BitPCM(new Float32Array(frame));

    try {
      socket.send(pcmBuffer);
    } catch (err) {
      console.error('Worker send error:', err);
    }
  }
}

function cleanup() {
  if (socket) {
    socket.close();
    socket = null;
  }
  audioBufferQueue = [];
}