export interface SoundEntry {
  code: string;
  name: string;
  category: string;
}

export const AMBIENT_SOUNDS: SoundEntry[] = [
  // Water
  { code: 'aa', name: 'Brook', category: 'Water' },
  { code: 'ab', name: 'Creek', category: 'Water' },
  { code: 'ac', name: 'Stream', category: 'Water' },
  { code: 'ad', name: 'Close Waterfall', category: 'Water' },
  { code: 'ae', name: 'Distant Waterfall', category: 'Water' },
  { code: 'ba', name: 'Calm Shore', category: 'Water' },
  { code: 'bb', name: 'Shore', category: 'Water' },
  { code: 'bc', name: 'Wild Shore', category: 'Water' },
  { code: 'bd', name: 'Ocean Waves', category: 'Water' },
  { code: 'be', name: 'Large Waves', category: 'Water' },
  // Weather
  { code: 'ca', name: 'Rain Drops', category: 'Weather' },
  { code: 'cb', name: 'Pouring Rain', category: 'Weather' },
  { code: 'cc', name: 'Distant Thunder', category: 'Weather' },
  { code: 'cd', name: 'Closer Thunder', category: 'Weather' },
  // Wind
  { code: 'ce', name: 'Coastal Wind', category: 'Wind' },
  { code: 'cf', name: 'Forest Wind', category: 'Wind' },
  { code: 'cg', name: 'Autumn Breeze', category: 'Wind' },
  // Nature
  { code: 'da', name: 'Birds', category: 'Nature' },
  { code: 'db', name: 'Frogs', category: 'Nature' },
  { code: 'dc', name: 'Summer Night', category: 'Nature' },
  { code: 'dd', name: 'Heat Wave', category: 'Nature' },
  // Fire
  { code: 'ea', name: 'Bonfire', category: 'Fire' },
  // Human
  { code: 'fa', name: 'Coffee House', category: 'Human' },
  { code: 'fb', name: 'Cocktail Voices', category: 'Human' },
  { code: 'ga', name: 'Meditation Time', category: 'Human' },
  { code: 'gb', name: 'Wind Chimes', category: 'Human' },
  // Mechanical
  { code: 'ha', name: 'Fan Noise', category: 'Mechanical' },
  // Technical
  { code: 'ia', name: 'Brown Noise', category: 'Technical' },
  { code: 'ib', name: 'Pink Noise', category: 'Technical' },
  { code: 'ic', name: 'White Noise', category: 'Technical' },
];

export const TICK_SOUND_CODE = 'ticking-fast';
export const BELL_SOUND_CODE = 'alarm-kitchen';

export const ALL_SOUND_CODES = [
  ...AMBIENT_SOUNDS.map((s) => s.code),
  TICK_SOUND_CODE,
  BELL_SOUND_CODE,
];

export const VOLUME_MULTIPLIERS: Record<string, number> = {
  off: 0,
  low: 0.3,
  medium: 0.6,
  high: 1.0,
};

export const SOUND_CATEGORIES = [...new Set(AMBIENT_SOUNDS.map((s) => s.category))];
