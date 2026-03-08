import { SYNC_VERSION, isCompatibleVersion, needsMigration } from '../../sync/version';

describe('SYNC_VERSION', () => {
  it('is a positive integer', () => {
    expect(SYNC_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SYNC_VERSION)).toBe(true);
  });
});

describe('isCompatibleVersion', () => {
  it('treats undefined (pre-versioning) as compatible', () => {
    expect(isCompatibleVersion(undefined)).toBe(true);
  });

  it('treats version 0 as compatible', () => {
    expect(isCompatibleVersion(0)).toBe(true);
  });

  it('treats equal version as compatible', () => {
    expect(isCompatibleVersion(SYNC_VERSION)).toBe(true);
  });

  it('treats lower version as compatible', () => {
    expect(isCompatibleVersion(SYNC_VERSION - 1)).toBe(true);
  });

  it('treats higher version as incompatible', () => {
    expect(isCompatibleVersion(SYNC_VERSION + 1)).toBe(false);
  });
});

describe('needsMigration', () => {
  it('needs migration for undefined (pre-versioning)', () => {
    expect(needsMigration(undefined)).toBe(true);
  });

  it('needs migration for version 0', () => {
    expect(needsMigration(0)).toBe(true);
  });

  it('does not need migration for current version', () => {
    expect(needsMigration(SYNC_VERSION)).toBe(false);
  });

  it('does not need migration for future version', () => {
    expect(needsMigration(SYNC_VERSION + 1)).toBe(false);
  });
});
