import { videoSourceKey, videoThumbnailKey } from './storage.keys';

describe('storage keys', () => {
  it('builds the source key', () => {
    expect(videoSourceKey('abc')).toBe('videos/abc/source');
  });

  it('builds the thumbnail key', () => {
    expect(videoThumbnailKey('abc')).toBe('videos/abc/thumbnail.jpg');
  });
});
