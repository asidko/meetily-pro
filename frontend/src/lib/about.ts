export const REPO_URL = 'https://github.com/asidko/meetily-pro';
export const AUTHOR = { name: 'Alexander Sidko', url: 'https://github.com/asidko' };

export interface ReleaseHighlights {
  version: string;
  highlights: string[];
}

export const WHATS_NEW: ReleaseHighlights[] = [
  {
    version: '1.10.1',
    highlights: [
      'The app updates itself, and Fedora gets its own package',
      'Drop files onto the import window, resize the assistant during a call',
    ],
  },
  {
    version: '1.10.0',
    highlights: [
      'Video imports keep only the sound, and the assistant panel can be resized',
      'Queue chat messages while the assistant answers, and edit the key terms',
    ],
  },
  {
    version: '1.9.0',
    highlights: [
      'Fix any transcript line with the pencil, during a call or later',
      'Assistant tips appear in the chat in the order they come',
    ],
  },
];

export interface Credit {
  name: string;
  license: string;
  url: string;
}

export const CREDITS: Credit[] = [
  { name: 'Meetily by Zackriya Solutions', license: 'MIT', url: 'https://github.com/Zackriya-Solutions/meetily' },
  { name: 'whisper.cpp', license: 'MIT', url: 'https://github.com/ggml-org/whisper.cpp' },
  { name: 'llama.cpp', license: 'MIT', url: 'https://github.com/ggml-org/llama.cpp' },
  { name: 'NVIDIA Parakeet', license: 'CC BY 4.0', url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3' },
  { name: 'Silero VAD', license: 'MIT', url: 'https://github.com/snakers4/silero-vad' },
  { name: 'FFmpeg', license: 'GPL', url: 'https://ffmpeg.org' },
  { name: 'Tauri', license: 'MIT / Apache-2.0', url: 'https://tauri.app' },
];
