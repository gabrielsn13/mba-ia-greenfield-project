import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidVideoStateException,
  UnsupportedContentTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const PART_SIZE = 100 * 1024 * 1024;
const MAX_SIZE = 10_000_000_000;

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<
    Pick<Repository<Video>, 'create' | 'save' | 'update' | 'delete'>
  > & { createQueryBuilder: jest.Mock };
  let channelRepository: { findOne: jest.Mock };
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'presignUploadPart'
      | 'listParts'
      | 'abortMultipartUpload'
    >
  >;
  let ownedVideo: Video | null;

  beforeEach(() => {
    ownedVideo = null;
    videoRepository = {
      create: jest.fn((data) => data as Video),
      save: jest.fn((data) => Promise.resolve(data as Video)),
      update: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const qb = {
          innerJoin: () => qb,
          where: () => qb,
          andWhere: () => qb,
          getOne: () => Promise.resolve(ownedVideo),
        };
        return qb;
      }),
    } as never;
    channelRepository = { findOne: jest.fn().mockResolvedValue({ id: 'ch1' }) };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn((_k, _u, n: number) =>
        Promise.resolve(`https://signed/${n}`),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      abortMultipartUpload: jest.fn(),
    };
    service = new VideosService(
      videoRepository as unknown as Repository<Video>,
      channelRepository as unknown as Repository<Channel>,
      storage as unknown as StorageService,
      {
        uploadPartSizeBytes: PART_SIZE,
        maxVideoSizeBytes: MAX_SIZE,
      } as never,
    );
  });

  const draft = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'v1',
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      source_key: 'videos/v1/source',
      size_bytes: PART_SIZE * 2 + 1,
      ...overrides,
    }) as Video;

  describe('initiateUpload', () => {
    const input = {
      filename: 'a.mp4',
      contentType: 'video/mp4',
      sizeBytes: PART_SIZE * 2 + 1,
    };

    it('rejects non video content types', async () => {
      await expect(
        service.initiateUpload('u1', { ...input, contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(UnsupportedContentTypeException);
    });

    it('rejects sizes above the limit', async () => {
      await expect(
        service.initiateUpload('u1', { ...input, sizeBytes: MAX_SIZE + 1 }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
    });

    it('rejects users without a channel', async () => {
      channelRepository.findOne.mockResolvedValue(null);

      await expect(service.initiateUpload('u1', input)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
    });

    it('creates the draft and the multipart upload', async () => {
      const result = await service.initiateUpload('u1', input);

      expect(result).toMatchObject({
        uploadId: 'upload-1',
        partSize: PART_SIZE,
        totalParts: 3,
      });
      expect(result.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: result.videoId },
        { upload_id: 'upload-1' },
      );
    });

    it('removes the draft when the storage fails', async () => {
      storage.createMultipartUpload.mockRejectedValue(new Error('boom'));

      await expect(service.initiateUpload('u1', input)).rejects.toThrow('boom');
      expect(videoRepository.delete).toHaveBeenCalled();
    });
  });

  describe('ownership and state', () => {
    it('throws VideoNotFoundException for non-owners', async () => {
      await expect(service.signParts('u2', 'v1', [1])).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      await expect(service.listParts('u2', 'v1')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      await expect(service.abortUpload('u2', 'v1')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('throws InvalidVideoStateException outside draft', async () => {
      ownedVideo = draft({ status: VideoStatus.PROCESSING });

      await expect(service.signParts('u1', 'v1', [1])).rejects.toBeInstanceOf(
        InvalidVideoStateException,
      );
      await expect(service.listParts('u1', 'v1')).rejects.toBeInstanceOf(
        InvalidVideoStateException,
      );
      await expect(service.abortUpload('u1', 'v1')).rejects.toBeInstanceOf(
        InvalidVideoStateException,
      );
    });
  });

  describe('signParts', () => {
    it('returns a URL per part', async () => {
      ownedVideo = draft();

      await expect(service.signParts('u1', 'v1', [1, 3])).resolves.toEqual([
        { partNumber: 1, url: 'https://signed/1' },
        { partNumber: 3, url: 'https://signed/3' },
      ]);
    });

    it('rejects part numbers beyond totalParts', async () => {
      ownedVideo = draft();

      await expect(service.signParts('u1', 'v1', [4])).rejects.toThrow(
        'partNumbers must be between 1 and 3',
      );
    });
  });

  describe('abortUpload', () => {
    it('aborts the multipart and deletes the draft', async () => {
      ownedVideo = draft();

      await service.abortUpload('u1', 'v1');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/v1/source',
        'upload-1',
      );
      expect(videoRepository.delete).toHaveBeenCalledWith({ id: 'v1' });
    });
  });
});
