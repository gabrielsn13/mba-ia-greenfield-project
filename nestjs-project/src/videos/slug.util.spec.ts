import { generateSlug } from './slug.util';

describe('generateSlug', () => {
  it('returns 11 base64url characters', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('produces unique values in a sample', () => {
    const sample = new Set(Array.from({ length: 5000 }, () => generateSlug()));

    expect(sample.size).toBe(5000);
  });
});
