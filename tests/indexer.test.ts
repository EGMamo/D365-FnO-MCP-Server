import { describe, it, expect } from 'vitest';
import { openDb } from '../src/indexer/db.js';

describe('Indexer DB Tests', () => {
  it('should initialize memory db properly', () => {
    const db = openDb(':memory:');
    expect(db).toBeDefined();
    db.close();
  });
});
