import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export class MediaProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}

export interface ProbeResult {
  durationSeconds: number;
  metadata: Record<string, unknown>;
}

export interface ThumbnailResult {
  data: Buffer;
  contentType: 'image/jpeg';
}

export function parseProbeOutput(stdout: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new MediaProcessingError('ffprobe returned invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MediaProcessingError('ffprobe returned an unexpected payload');
  }
  const metadata = parsed as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  const hasVideo = metadata.streams?.some((s) => s.codec_type === 'video');
  if (!hasVideo) {
    throw new MediaProcessingError('file has no video stream');
  }
  const durationSeconds = Number(metadata.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaProcessingError('could not determine video duration');
  }
  return {
    durationSeconds,
    metadata: metadata as Record<string, unknown>,
  };
}

@Injectable()
export class MediaToolsService {
  async probe(url: string): Promise<ProbeResult> {
    const { stdout } = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    return parseProbeOutput(stdout.toString('utf8'));
  }

  async extractThumbnail(
    url: string,
    durationSeconds: number,
  ): Promise<ThumbnailResult> {
    const dir = await mkdtemp(join(tmpdir(), 'thumb-'));
    const file = join(dir, 'thumbnail.jpg');
    try {
      await this.run('ffmpeg', [
        '-v',
        'error',
        '-ss',
        (durationSeconds * 0.1).toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        file,
      ]);
      const data = await readFile(file).catch(() => {
        throw new MediaProcessingError('ffmpeg produced no thumbnail');
      });
      if (data.length === 0) {
        throw new MediaProcessingError('ffmpeg produced an empty thumbnail');
      }
      return { data, contentType: 'image/jpeg' };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private run(
    command: string,
    args: string[],
  ): Promise<{ stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let outSize = 0;
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(() => reject(new MediaProcessingError(`${command} timed out`)));
      }, TOOL_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        outSize += chunk.length;
        if (outSize > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(() =>
            reject(new MediaProcessingError(`${command} output too large`)),
          );
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8');
      });
      child.on('error', (err) =>
        finish(() =>
          reject(new MediaProcessingError(`${command} failed: ${err.message}`)),
        ),
      );
      child.on('close', (code) =>
        finish(() =>
          code === 0
            ? resolve({ stdout: Buffer.concat(out), stderr })
            : reject(
                new MediaProcessingError(
                  `${command} exited with code ${code}: ${stderr
                    .replace(/https?:\/\/\S+/g, '<url>')
                    .trim()}`,
                ),
              ),
        ),
      );
    });
  }
}
