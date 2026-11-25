import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaProcessingError, MediaToolsService } from './media-tools.service';

describe('MediaToolsService (integration, real ffmpeg/ffprobe)', () => {
  let dir: string;
  let videoPath: string;
  let textPath: string;
  const service = new MediaToolsService();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'media-fixture-'));
    videoPath = join(dir, 'sample.mp4');
    textPath = join(dir, 'not-a-video.mp4');
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ]);
    writeFileSync(textPath, 'this is not a video');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const thumbDirs = () =>
    readdirSync(tmpdir()).filter((name) => name.startsWith('thumb-'));

  it('probes a 5s video', async () => {
    const result = await service.probe(videoPath);
    expect(result.durationSeconds).toBeCloseTo(5, 0);
    const metadata = result.metadata as { format: unknown; streams: unknown[] };
    expect(metadata.format).toBeDefined();
    expect(metadata.streams.length).toBeGreaterThan(0);
  });

  it('extracts a non-empty JPEG thumbnail without leaving temp files', async () => {
    const before = thumbDirs().length;
    const thumb = await service.extractThumbnail(videoPath, 5);
    expect(thumb.contentType).toBe('image/jpeg');
    expect(thumb.data.length).toBeGreaterThan(0);
    expect([...thumb.data.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(thumbDirs().length).toBe(before);
  });

  it('rejects a non-video file with a typed error', async () => {
    await expect(service.probe(textPath)).rejects.toBeInstanceOf(
      MediaProcessingError,
    );
  });

  it('cleans temp files when thumbnail extraction fails', async () => {
    const before = thumbDirs().length;
    await expect(service.extractThumbnail(textPath, 5)).rejects.toBeInstanceOf(
      MediaProcessingError,
    );
    expect(thumbDirs().length).toBe(before);
  });
});
