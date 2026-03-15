import { initFieldTimestamps, stampUpdatedFields, mergeEntity } from '../../sync/field-timestamps';

describe('initFieldTimestamps', () => {
  it('stamps all non-excluded keys', () => {
    const entity = { id: 'x', title: 'T', status: 'todo', order: 0, createdAt: 100, updatedAt: 100 };
    const ft = initFieldTimestamps(entity, 100);
    expect(ft).toEqual({ title: 100, status: 100, order: 100, updatedAt: 100 });
    // Excluded fields not present
    expect(ft.id).toBeUndefined();
    expect(ft.createdAt).toBeUndefined();
    expect(ft.fieldTimestamps).toBeUndefined();
  });

  it('handles entity with optional fields', () => {
    const entity = { id: 'x', title: 'T', description: 'D', createdAt: 50, updatedAt: 50 };
    const ft = initFieldTimestamps(entity, 50);
    expect(ft.title).toBe(50);
    expect(ft.description).toBe(50);
  });
});

describe('stampUpdatedFields', () => {
  it('stamps changed keys preserving existing', () => {
    const existing = { title: 100, status: 100, order: 100 };
    const result = stampUpdatedFields(existing, ['title'], 200);
    expect(result).toEqual({ title: 200, status: 100, order: 100 });
  });

  it('handles undefined existing FT', () => {
    const result = stampUpdatedFields(undefined, ['title', 'status'], 300);
    expect(result).toEqual({ title: 300, status: 300 });
  });

  it('ignores excluded fields', () => {
    const result = stampUpdatedFields({}, ['id', 'createdAt', 'fieldTimestamps', 'title'], 100);
    expect(result).toEqual({ title: 100 });
  });
});

describe('mergeEntity', () => {
  const base = (overrides = {}) => ({
    id: 'task-1',
    title: 'Local Title',
    description: 'Local Desc',
    status: 'todo',
    order: 0,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  });

  describe('field-level merge (both have fieldTimestamps)', () => {
    it('different fields edited — both preserved', () => {
      const local = base({
        title: 'Local Title',
        description: 'Local Desc',
        updatedAt: 200,
        fieldTimestamps: { title: 200, description: 100, status: 100, order: 100, updatedAt: 200 },
      });
      const remote = base({
        title: 'Remote Title',
        description: 'Remote Desc',
        updatedAt: 200,
        fieldTimestamps: { title: 100, description: 200, status: 100, order: 100, updatedAt: 200 },
      });

      const merged = mergeEntity(local, remote, 200);
      expect(merged).not.toBeNull();
      expect(merged!.title).toBe('Local Title'); // local has newer title timestamp
      expect(merged!.description).toBe('Remote Desc'); // remote has newer description timestamp
    });

    it('same field, remote newer — remote wins', () => {
      const local = base({
        title: 'Local Title',
        updatedAt: 200,
        fieldTimestamps: { title: 200, status: 100, order: 100, updatedAt: 200 },
      });
      const remote = base({
        title: 'Remote Title',
        updatedAt: 300,
        fieldTimestamps: { title: 300, status: 100, order: 100, updatedAt: 300 },
      });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).not.toBeNull();
      expect(merged!.title).toBe('Remote Title');
    });

    it('same field, local newer — local wins (no change)', () => {
      const local = base({
        title: 'Local Title',
        updatedAt: 300,
        fieldTimestamps: { title: 300, status: 100, order: 100, updatedAt: 300 },
      });
      const remote = base({
        title: 'Remote Title',
        updatedAt: 200,
        fieldTimestamps: { title: 200, status: 100, order: 100, updatedAt: 200 },
      });

      const merged = mergeEntity(local, remote, 200);
      expect(merged).toBeNull(); // no change needed
    });

    it('tie — local wins', () => {
      const local = base({
        title: 'Local Title',
        updatedAt: 200,
        fieldTimestamps: { title: 200, status: 100, order: 100, updatedAt: 200 },
      });
      const remote = base({
        title: 'Remote Title',
        updatedAt: 200,
        fieldTimestamps: { title: 200, status: 100, order: 100, updatedAt: 200 },
      });

      const merged = mergeEntity(local, remote, 200);
      expect(merged).toBeNull(); // tie = local wins = no change
    });

    it('updatedAt is max of both sides', () => {
      const local = base({
        title: 'Local Title',
        updatedAt: 200,
        fieldTimestamps: { title: 200, status: 100, order: 100, updatedAt: 200 },
      });
      const remote = base({
        title: 'Remote Title',
        description: 'Remote Desc',
        updatedAt: 300,
        fieldTimestamps: { title: 100, description: 300, status: 100, order: 100, updatedAt: 300 },
      });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).not.toBeNull();
      expect(merged!.updatedAt).toBe(300);
    });

    it('field present only on remote side is taken when remote timestamp is newer', () => {
      const local = base({
        updatedAt: 200,
        fieldTimestamps: { title: 200, status: 100, order: 100, updatedAt: 200 },
      });
      // Remote has a dueDate field that local doesn't
      const remote = base({
        dueDate: 999,
        updatedAt: 300,
        fieldTimestamps: { title: 100, status: 100, order: 100, dueDate: 300, updatedAt: 300 },
      });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).not.toBeNull();
      expect(merged!.dueDate).toBe(999);
    });

    it('field present only on local side is preserved', () => {
      const local = base({
        dueDate: 888,
        updatedAt: 300,
        fieldTimestamps: { title: 200, status: 100, order: 100, dueDate: 200, updatedAt: 300 },
      });
      const remote = base({
        updatedAt: 300,
        fieldTimestamps: { title: 100, status: 100, order: 100, updatedAt: 300 },
      });

      const merged = mergeEntity(local, remote, 300);
      // dueDate has localTs=200, remoteTs=0, so local keeps it
      // No remote field is newer → no change
      expect(merged).toBeNull();
    });

    it('mergedFT is updated for fields remote wins', () => {
      const local = base({
        title: 'Local',
        description: 'Local Desc',
        updatedAt: 200,
        fieldTimestamps: { title: 200, description: 100, status: 100, order: 100, updatedAt: 200 },
      });
      const remote = base({
        title: 'Remote',
        description: 'Remote Desc',
        updatedAt: 300,
        fieldTimestamps: { title: 100, description: 300, status: 100, order: 100, updatedAt: 300 },
      });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).not.toBeNull();
      const ft = merged!.fieldTimestamps as Record<string, number>;
      expect(ft.title).toBe(200); // local won
      expect(ft.description).toBe(300); // remote won
    });
  });

  describe('entity-level LWW fallback', () => {
    it('one side missing fieldTimestamps — remote wins when newer', () => {
      const local = base({ updatedAt: 200 }); // no fieldTimestamps
      const remote = base({ title: 'Remote', updatedAt: 300, fieldTimestamps: { title: 300 } });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).not.toBeNull();
      expect(merged!.title).toBe('Remote');
    });

    it('one side missing fieldTimestamps — local wins when newer', () => {
      const local = base({ updatedAt: 500, fieldTimestamps: { title: 500 } });
      const remote = base({ title: 'Remote', updatedAt: 300 }); // no fieldTimestamps

      const merged = mergeEntity(local, remote, 300);
      expect(merged).toBeNull();
    });

    it('neither has fieldTimestamps — remote wins when newer (backward compat)', () => {
      const local = base({ updatedAt: 200 });
      const remote = base({ title: 'Remote', updatedAt: 300 });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).not.toBeNull();
      expect(merged!.title).toBe('Remote');
    });

    it('neither has fieldTimestamps — local wins when newer', () => {
      const local = base({ updatedAt: 500 });
      const remote = base({ title: 'Remote', updatedAt: 300 });

      const merged = mergeEntity(local, remote, 300);
      expect(merged).toBeNull();
    });

    it('entity-level LWW ties go to remote (>= check)', () => {
      const local = base({ updatedAt: 200 });
      const remote = base({ title: 'Remote', updatedAt: 200 });

      const merged = mergeEntity(local, remote, 200);
      expect(merged).not.toBeNull();
      expect(merged!.title).toBe('Remote');
    });
  });
});
