import { NestFactory } from '@nestjs/core';
import { WorkerRootModule } from './video-worker/worker-root.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerRootModule);
  app.enableShutdownHooks();
}

void bootstrap();
