import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

import type { Logger } from "./logger.js";

const run = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 50;
// Comfortably under the SQS visibility timeout (10 min, see TranscodeStack)
// so a hung/corrupt input fails the job cleanly and lets it retry, instead of
// the promise never resolving — a job stuck in execFile forever would leak
// one of this process's concurrency slots for its entire remaining lifetime,
// silently shrinking a worker's real capacity job by job.
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;

interface VideoRendition {
  height: number;
  bitrate: string;
}

interface AudioRendition {
  bitrate: string;
}

const VIDEO_LADDER: readonly VideoRendition[] = [
  { height: 1080, bitrate: "5000k" },
  { height: 720, bitrate: "2800k" },
  { height: 480, bitrate: "1400k" },
];

const AUDIO_LADDER: readonly AudioRendition[] = [{ bitrate: "128k" }, { bitrate: "64k" }];

/** Returns the source video's height, or null if it has no video stream (audio-only). */
async function probeHeight(inputPath: string, logger: Logger, signal?: AbortSignal): Promise<number | null> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", inputPath],
      { timeout: FFPROBE_TIMEOUT_MS, signal }
    );
    const height = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(height) ? height : null;
  } catch (error) {
    // A genuine ffprobe failure (corrupt file, missing binary, permission
    // error) looks identical to "no video stream" without this — logged as a
    // warning rather than rethrown, since the caller's fallback (treat as
    // audio-only) is still a reasonable thing to attempt.
    logger.warn("ffprobe failed to read video stream height", { inputPath, error });
    return null;
  }
}

/** `signal` lets the caller kill an in-progress ffmpeg subprocess as soon as
 * the job's overall deadline passes, instead of waiting out FFMPEG_TIMEOUT_MS
 * on its own — the subprocess is the one piece of this pipeline that would
 * otherwise keep running (and holding CPU) after the job has already been
 * given up on. */
export async function transcodeToHls(
  inputPath: string,
  outputDir: string,
  logger: Logger,
  signal?: AbortSignal
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const sourceHeight = await probeHeight(inputPath, logger, signal);

  if (sourceHeight) {
    await transcodeVideo(inputPath, outputDir, sourceHeight, signal);
  } else {
    await transcodeAudio(inputPath, outputDir, signal);
  }
}

async function transcodeVideo(
  inputPath: string,
  outputDir: string,
  sourceHeight: number,
  signal?: AbortSignal
): Promise<void> {
  // Never upscale — only include renditions at or below the source resolution.
  const renditions = VIDEO_LADDER.filter((r) => r.height <= sourceHeight);
  if (renditions.length === 0) {
    const smallest = VIDEO_LADDER[VIDEO_LADDER.length - 1];
    if (smallest) renditions.push(smallest);
  }

  const splitLabels = renditions.map((_, i) => `[v${i}]`).join("");
  const splitFilter = `[0:v]split=${renditions.length}${splitLabels}`;
  const scaleFilters = renditions.map((r, i) => `[v${i}]scale=-2:${r.height}[v${i}out]`).join("; ");

  const args = ["-y", "-i", inputPath, "-filter_complex", `${splitFilter}; ${scaleFilters}`];

  renditions.forEach((r, i) => {
    args.push("-map", `[v${i}out]`, `-c:v:${i}`, "libx264", `-b:v:${i}`, r.bitrate);
  });
  renditions.forEach((_, i) => {
    args.push("-map", "a:0?", `-c:a:${i}`, "aac", `-b:a:${i}`, "128k");
  });

  args.push(
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", renditions.map((_, i) => `v:${i},a:${i}`).join(" "),
    "-hls_segment_filename", `${outputDir}/%v_%03d.ts`,
    `${outputDir}/%v.m3u8`
  );

  await run("ffmpeg", args, { maxBuffer: MAX_BUFFER, timeout: FFMPEG_TIMEOUT_MS, signal });
}

async function transcodeAudio(inputPath: string, outputDir: string, signal?: AbortSignal): Promise<void> {
  const args = ["-y", "-i", inputPath];

  AUDIO_LADDER.forEach((r, i) => {
    args.push("-map", "0:a", `-c:a:${i}`, "aac", `-b:a:${i}`, r.bitrate);
  });

  args.push(
    "-f", "hls",
    "-hls_time", "6",
    "-hls_playlist_type", "vod",
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", AUDIO_LADDER.map((_, i) => `a:${i}`).join(" "),
    "-hls_segment_filename", `${outputDir}/%v_%03d.ts`,
    `${outputDir}/%v.m3u8`
  );

  await run("ffmpeg", args, { maxBuffer: MAX_BUFFER, timeout: FFMPEG_TIMEOUT_MS, signal });
}
