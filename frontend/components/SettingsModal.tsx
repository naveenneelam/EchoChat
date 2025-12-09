import React, { useState } from 'react';
import { AppConfig } from '../types';
import { X, Save, AlertTriangle } from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: AppConfig;
  onSave: (newConfig: AppConfig) => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, config, onSave }) => {
  const [formData, setFormData] = useState<AppConfig>(config);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: name === 'wsUrl' ? value : Number(value)
    }));
  };

  const handleSave = () => {
    onSave(formData);
    onClose();
  };

  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const hasProtocolMismatch = isSecure && formData.wsUrl.startsWith('ws://');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-dark-900 rounded-2xl shadow-xl w-full max-w-md p-6 border border-gray-200 dark:border-dark-800">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Settings</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 dark:hover:bg-dark-800 rounded-full transition-colors">
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              WebSocket URL
            </label>
            <input
              type="text"
              name="wsUrl"
              value={formData.wsUrl}
              onChange={handleChange}
              placeholder="wss://..."
              className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-dark-800 bg-white dark:bg-dark-950 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 outline-none"
            />
            {hasProtocolMismatch && (
                <div className="flex items-start gap-2 mt-2 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 p-2 rounded">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <p>
                        Warning: Your page is secure (HTTPS), but you are using an insecure WebSocket URL (ws://). This will likely be blocked by the browser. Please use <strong>wss://</strong>.
                    </p>
                </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Pause Duration Threshold (ms)
            </label>
            <input
              type="number"
              name="pauseThreshold"
              value={formData.pauseThreshold}
              onChange={handleChange}
              className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-dark-800 bg-white dark:bg-dark-950 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 outline-none"
            />
            <p className="text-xs text-gray-500 mt-1">Duration of silence to trigger ASR processing.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              VAD Sensitivity (Amplitude 0.0 - 1.0)
            </label>
            <input
              type="number"
              name="silenceThreshold"
              step="0.001"
              max="1"
              min="0"
              value={formData.silenceThreshold}
              onChange={handleChange}
              className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-dark-800 bg-white dark:bg-dark-950 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 outline-none"
            />
          </div>
        </div>

        <div className="mt-8 flex justify-end">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-6 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg font-medium transition-colors"
          >
            <Save size={18} />
            Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;