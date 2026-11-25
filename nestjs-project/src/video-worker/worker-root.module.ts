import { Module } from '@nestjs/common';
import { AppModule } from '../app.module';
import { VideoWorkerModule } from './video-worker.module';

@Module({ imports: [AppModule, VideoWorkerModule] })
export class WorkerRootModule {}
