import { describe, it, expect } from 'vitest';

// Sanity check that the test runner and TS pipeline work.
// Replaced by real suites in stage 1+.
describe('scaffold', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
