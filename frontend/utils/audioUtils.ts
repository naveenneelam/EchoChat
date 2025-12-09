/**
 * Converts float audio data (from the browser's AudioContext)
 * to 16-bit PCM (required by webrtcvad/silero vad)
 */
export function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    // Scale float (-1 to 1) to 16-bit short (-32768 to 32767)
    // Clamp values to avoid overflow/distortion
    const s = Math.max(-1, Math.min(1, input[i]));
    // Write as little-endian
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

/**
 * Calculates the Root Mean Square (RMS) amplitude of a buffer
 * Used for visualizers and simple client-side VAD visualization
 */
export function calculateRMS(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input[i] * input[i];
  }
  return Math.sqrt(sum / input.length);
}

/**
 * Downsamples a Float32Array from inputSampleRate to outputSampleRate
 * using simple averaging to prevent aliasing.
 */
export function downsampleBuffer(buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }
  
  if (outputSampleRate > inputSampleRate) {
    throw new Error("Upsampling is not supported");
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  
  for (let i = 0; i < newLength; i++) {
    const startOffset = Math.floor(i * sampleRateRatio);
    const endOffset = Math.floor((i + 1) * sampleRateRatio);
    let sum = 0;
    let count = 0;
    
    for (let j = startOffset; j < endOffset && j < buffer.length; j++) {
      sum += buffer[j];
      count++;
    }
    
    result[i] = count > 0 ? sum / count : 0;
  }
  
  return result;
}