import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class InitiateUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  // The video/* rule is a domain check (415 UNSUPPORTED_CONTENT_TYPE) in the service.
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title?: string;
}
