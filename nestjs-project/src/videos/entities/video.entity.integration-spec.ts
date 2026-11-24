import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: `owner${counter}`,
      user_id: user.id,
    });
  });

  const newVideo = (slug: string, overrides: Partial<Video> = {}) =>
    videoRepository.create({
      slug,
      channel_id: channel.id,
      title: 'Untitled',
      content_type: 'video/mp4',
      size_bytes: 10_000_000_000,
      source_key: `videos/${slug}/source`,
      ...overrides,
    });

  it('should default status to draft and nullable fields to null', async () => {
    const video = await videoRepository.save(newVideo('aaaaaaaaaaa'));

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.failure_reason).toBeNull();
    expect(video.processing_started_at).toBeNull();
  });

  it('should round-trip bigint size, numeric duration and jsonb metadata', async () => {
    const saved = await videoRepository.save(
      newVideo('bbbbbbbbbbb', {
        duration_seconds: 125.482,
        metadata: { format: { format_name: 'mov,mp4' }, streams: [] },
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10_000_000_000);
    expect(found.duration_seconds).toBe(125.482);
    expect(found.metadata).toEqual({
      format: { format_name: 'mov,mp4' },
      streams: [],
    });
  });

  it('should enforce unique slug', async () => {
    await videoRepository.save(newVideo('ccccccccccc'));

    await expect(
      videoRepository.save(newVideo('ccccccccccc')),
    ).rejects.toThrow();
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      videoRepository.save(
        newVideo('ddddddddddd', { status: 'archived' as VideoStatus }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a video for a non-existent channel', async () => {
    await expect(
      videoRepository.save(
        newVideo('eeeeeeeeeee', {
          channel_id: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should load the related channel', async () => {
    await videoRepository.save(newVideo('fffffffffff'));

    const found = await videoRepository.findOneOrFail({
      where: { slug: 'fffffffffff' },
      relations: ['channel'],
    });

    expect(found.channel.id).toBe(channel.id);
  });
});
