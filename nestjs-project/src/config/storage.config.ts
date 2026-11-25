import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.S3_PUBLIC_ENDPOINT ||
    process.env.S3_ENDPOINT ||
    'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY as string,
  secretKey: process.env.S3_SECRET_KEY as string,
  bucket: process.env.S3_BUCKET || 'videos',
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '104857600',
    10,
  ),
  maxVideoSizeBytes: parseInt(
    process.env.MAX_VIDEO_SIZE_BYTES || '10000000000',
    10,
  ),
  presignedUrlExpirationSeconds: parseInt(
    process.env.PRESIGNED_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
}));
