import { Test } from '@nestjs/testing';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and expose StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [StorageModule],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    await module.close();
  });
});
