import { MediaProcessingError, parseProbeOutput } from './media-tools.service';

const video = { codec_type: 'video' };

describe('parseProbeOutput', () => {
  it('returns duration and raw metadata', () => {
    const payload = { format: { duration: '5.04' }, streams: [video] };
    const result = parseProbeOutput(JSON.stringify(payload));
    expect(result.durationSeconds).toBeCloseTo(5.04);
    expect(result.metadata).toEqual(payload);
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['non-object payload', '42'],
    [
      'no video stream',
      JSON.stringify({
        format: { duration: '3' },
        streams: [{ codec_type: 'audio' }],
      }),
    ],
    ['missing duration', JSON.stringify({ format: {}, streams: [video] })],
    [
      'zero duration',
      JSON.stringify({ format: { duration: '0' }, streams: [video] }),
    ],
  ])('rejects %s', (_label, stdout) => {
    expect(() => parseProbeOutput(stdout)).toThrow(MediaProcessingError);
  });
});
