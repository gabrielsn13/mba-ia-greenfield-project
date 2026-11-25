import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessor } from './video-processor';

@Module({
  imports: [VideosModule, StorageModule],
  providers: [MediaToolsService, VideoProcessor],
})
export class VideoWorkerModule {}
