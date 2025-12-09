import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isRecording: boolean;
  analyser: AnalyserNode | null;
  vadActive: boolean;
  mode: 'frequency' | 'waveform';
}

const Visualizer: React.FC<VisualizerProps> = ({ isRecording, analyser, vadActive, mode }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // We allocate the data array once to avoid garbage collection in the loop
    let dataArray: Uint8Array;
    if (analyser) {
        // Create buffer based on the mode requirements
        const bufferLength = mode === 'frequency' ? analyser.frequencyBinCount : analyser.fftSize;
        dataArray = new Uint8Array(bufferLength);
    }

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;
      
      // Clear canvas
      ctx.clearRect(0, 0, width, height);
      
      // Idle state
      if (!isRecording || !analyser) {
          ctx.beginPath();
          ctx.moveTo(0, height / 2);
          ctx.lineTo(width, height / 2);
          ctx.strokeStyle = '#374151'; // Gray-700
          ctx.lineWidth = 1;
          ctx.stroke();
          
          if (isRecording && !analyser) {
             // If recording but analyser not ready, request next frame
             animationRef.current = requestAnimationFrame(draw);
          }
          return;
      }

      // Fetch fresh data directly from the audio node
      if (mode === 'frequency') {
          analyser.getByteFrequencyData(dataArray);
      } else {
          analyser.getByteTimeDomainData(dataArray);
      }

      const centerX = width / 2;
      const centerY = height / 2;

      if (mode === 'frequency') {
        const radius = Math.min(width, height) / 3;

        // Base circle
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.strokeStyle = vadActive ? '#0ea5e9' : '#374151'; 
        ctx.lineWidth = 2;
        ctx.stroke();

        const barCount = 60;
        const angleStep = (2 * Math.PI) / barCount;
        
        // Use lower half of frequency data (more active for speech)
        const availableData = dataArray.length / 2; 
        const dataStep = Math.max(1, Math.floor(availableData / barCount));

        for (let i = 0; i < barCount; i++) {
          const dataIndex = Math.floor(i * dataStep);
          const value = dataArray[dataIndex] || 0;
          const percent = value / 255;
          const barHeight = percent * (radius * 0.8);
          
          const angle = i * angleStep;
          
          const startX = centerX + Math.cos(angle) * radius;
          const startY = centerY + Math.sin(angle) * radius;
          const endX = centerX + Math.cos(angle) * (radius + barHeight);
          const endY = centerY + Math.sin(angle) * (radius + barHeight);

          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.strokeStyle = vadActive ? `rgba(14, 165, 233, ${0.5 + percent})` : `rgba(156, 163, 175, ${0.2 + percent})`;
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.stroke();
        }

        // Pulse Center
        if (vadActive) {
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 0.9, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(14, 165, 233, 0.1)';
            ctx.fill();
        }

      } else {
        // --- WAVEFORM MODE ---
        
        // Dynamic Animation Variables
        const time = Date.now() / 1000;
        const pulseSpeed = vadActive ? 8 : 2; // Faster pulse when active
        const pulse = (Math.sin(time * pulseSpeed) + 1) / 2; // Oscillate 0..1

        // Styling based on VAD
        const baseColor = vadActive ? '14, 165, 233' : '75, 85, 99'; // Sky-500 vs Gray-600
        const opacity = vadActive ? 0.8 + (pulse * 0.2) : 0.5;
        const lineWidth = vadActive ? 3 + (pulse * 1.5) : 2; // Thicker when active
        
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = `rgba(${baseColor}, ${opacity})`;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        
        // Add Glow
        if (vadActive) {
            ctx.shadowBlur = 10 + (pulse * 10);
            ctx.shadowColor = `rgba(${baseColor}, 0.6)`;
        } else {
            ctx.shadowBlur = 0;
        }

        ctx.beginPath();

        const sliceWidth = width * 1.0 / dataArray.length;
        let x = 0;

        for (let i = 0; i < dataArray.length; i++) {
          const v = dataArray[i] / 128.0; // 128 is zero-crossing
          const y = (v * height) / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        ctx.lineTo(width, height / 2);
        ctx.stroke();
        
        // Reset Shadow for next frame
        ctx.shadowBlur = 0;
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [isRecording, analyser, vadActive, mode]);

  return (
    <canvas 
      ref={canvasRef} 
      width={600} 
      height={400} 
      className="w-full max-w-[400px] h-auto aspect-square mx-auto transition-all duration-300"
    />
  );
};

export default Visualizer;
