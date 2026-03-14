import { AMBIENT_SOUNDS, ALL_SOUND_CODES, TICK_SOUND_CODE, BELL_SOUND_CODE, VOLUME_MULTIPLIERS, SOUND_CATEGORIES } from '../../lib/pomodoro-sounds';

describe('pomodoro-sounds catalog', () => {
  it('contains exactly 30 ambient sounds', () => {
    expect(AMBIENT_SOUNDS).toHaveLength(30);
  });

  it('has unique codes across all ambient sounds', () => {
    const codes = AMBIENT_SOUNDS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('ALL_SOUND_CODES includes ambient + tick + bell', () => {
    expect(ALL_SOUND_CODES).toContain(TICK_SOUND_CODE);
    expect(ALL_SOUND_CODES).toContain(BELL_SOUND_CODE);
    expect(ALL_SOUND_CODES.length).toBe(30 + 2);
  });

  it('has expected categories', () => {
    expect(SOUND_CATEGORIES).toContain('Water');
    expect(SOUND_CATEGORIES).toContain('Weather');
    expect(SOUND_CATEGORIES).toContain('Wind');
    expect(SOUND_CATEGORIES).toContain('Nature');
    expect(SOUND_CATEGORIES).toContain('Fire');
    expect(SOUND_CATEGORIES).toContain('Human');
    expect(SOUND_CATEGORIES).toContain('Mechanical');
    expect(SOUND_CATEGORIES).toContain('Technical');
  });

  it('every sound has code, name, and category', () => {
    for (const sound of AMBIENT_SOUNDS) {
      expect(sound.code).toBeTruthy();
      expect(sound.name).toBeTruthy();
      expect(sound.category).toBeTruthy();
    }
  });

  it('volume multipliers cover all levels', () => {
    expect(VOLUME_MULTIPLIERS['off']).toBe(0);
    expect(VOLUME_MULTIPLIERS['low']).toBe(0.3);
    expect(VOLUME_MULTIPLIERS['medium']).toBe(0.6);
    expect(VOLUME_MULTIPLIERS['high']).toBe(1.0);
  });

  it('Water category has 10 sounds', () => {
    const water = AMBIENT_SOUNDS.filter((s) => s.category === 'Water');
    expect(water).toHaveLength(10);
  });

  it('tick and bell codes are correct', () => {
    expect(TICK_SOUND_CODE).toBe('ticking-fast');
    expect(BELL_SOUND_CODE).toBe('alarm-kitchen');
  });
});
