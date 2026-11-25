import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { ProcessVideoJobData } from '../videos/video-queue.constants';
import { MediaProcessingError, MediaToolsService } from './media-tools.service';
import { VideoProcessor } from './video-processor';

describe('VideoProcessor', () => {
  const videoId = 'video-1';
  const job = (
    overrides: Partial<Job<ProcessVideoJobData>> = {},
  ): Job<ProcessVideoJobData> =>
    ({
      data: { videoId },
      attemptsMade: 1,
      opts: { attempts: 3 },
      ...overrides,
    }) as Job<ProcessVideoJobData>;

  let repo: { findOneBy: jest.Mock; update: jest.Mock };
  let storage: {
    presignInternalGetObject: jest.Mock;
    putObject: jest.Mock;
    headObject: jest.Mock;
  };
  let media: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let processor: VideoProcessor;

  const processingVideo = {
    id: videoId,
    status: VideoStatus.PROCESSING,
    source_key: `videos/${videoId}/source`,
    size_bytes: 10,
  };

  beforeEach(() => {
    repo = { findOneBy: jest.fn(), update: jest.fn() };
    storage = {
      presignInternalGetObject: jest.fn().mockResolvedValue('http://signed'),
      putObject: jest.fn(),
      headObject: jest.fn().mockResolvedValue({ contentLength: 99 }),
    };
    media = {
      probe: jest
        .fn()
        .mockResolvedValue({ durationSeconds: 5, metadata: { a: 1 } }),
      extractThumbnail: jest.fn().mockResolvedValue({
        data: Buffer.from('jpg'),
        contentType: 'image/jpeg',
      }),
    };
    processor = new VideoProcessor(
      repo as unknown as Repository<Video>,
      storage as unknown as StorageService,
      media as unknown as MediaToolsService,
    );
  });

  it('marks a processing video as ready with metadata and thumbnail', async () => {
    repo.findOneBy.mockResolvedValue(processingVideo);

    await processor.process(job());

    expect(storage.putObject).toHaveBeenCalledWith(
      `videos/${videoId}/thumbnail.jpg`,
      expect.any(Buffer),
      'image/jpeg',
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: videoId, status: VideoStatus.PROCESSING },
      expect.objectContaining({
        status: VideoStatus.READY,
        duration_seconds: 5,
        metadata: { a: 1 },
        thumbnail_key: `videos/${videoId}/thumbnail.jpg`,
        size_bytes: 99,
      }),
    );
  });

  it.each([VideoStatus.READY, VideoStatus.ERROR, VideoStatus.DRAFT])(
    'is idempotent for a %s video',
    async (status) => {
      repo.findOneBy.mockResolvedValue({ ...processingVideo, status });

      await processor.process(job());

      expect(media.probe).not.toHaveBeenCalled();
      expect(storage.putObject).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    },
  );

  it('skips when the video does not exist', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await processor.process(job());
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('propagates media errors so BullMQ retries', async () => {
    repo.findOneBy.mockResolvedValue(processingVideo);
    media.probe.mockRejectedValue(new MediaProcessingError('bad file'));

    await expect(processor.process(job())).rejects.toBeInstanceOf(
      MediaProcessingError,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('does nothing while attempts remain', async () => {
      await processor.onFailed(job({ attemptsMade: 2 }), new Error('boom'));
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('marks the video as error after the last attempt', async () => {
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));
      expect(repo.update).toHaveBeenCalledWith(
        { id: videoId, status: VideoStatus.PROCESSING },
        { status: VideoStatus.ERROR, failure_reason: 'boom' },
      );
    });
  });
});
