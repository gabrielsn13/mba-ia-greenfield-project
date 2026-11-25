import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { MediaToolsService } from './media-tools.service';
import { VideoProcessor } from './video-processor';
import { VideoReconciliationService } from './video-reconciliation.service';

@Module({
  imports: [VideosModule, StorageModule],
  providers: [MediaToolsService, VideoProcessor, VideoReconciliationService],
})
export class VideoWorkerModule {}
