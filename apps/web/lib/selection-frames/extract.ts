import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { LocalVideoStorage } from "../storage/local";

export type Source = { key: string; sha256: string; bytes: number };
export type Frame = {
  idx: number;
  ms: number;
  width: number;
  height: number;
  key: string;
};
const running = new Set<string>();
const cache = new Map<string, { frames: Frame[]; hashes: string[] }>();
function boundedSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error("CONFIGURATION");
  return value;
}
// No shell, network inputs, parent credentials, or unbounded captured diagnostics.
export async function tool(
  command: "ffprobe" | "ffmpeg",
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      failed = false;
    const kill = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", kill, { once: true });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data: Buffer) => {
        if (Buffer.byteLength(output) + data.length > 65536) kill();
        else output += data.toString();
      });
    child.on("error", () => {
      failed = true;
    });
    // close follows exit AND closed pipes: always reap before returning/cleanup.
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (failed || code !== 0 || signal.aborted)
        reject(Error("SELECTION_UNAVAILABLE"));
      else resolve(output);
    });
  });
}
export async function extract(
  storage: LocalVideoStorage,
  source: Source,
  signal: AbortSignal,
) {
  const count = boundedSetting("SELECTION_FRAME_COUNT", 12, 2, 24);
  const maxDuration = boundedSetting("SELECTION_MAX_DURATION_S", 600, 1, 600);
  const identity = `${source.key}:${source.sha256}:${count}:${maxDuration}:v1`;
  // Fixed active and pending bound. Caller retries; no unbounded promise queue.
  if (running.has(identity) || running.size >= 2) throw Error("SELECTION_BUSY");
  running.add(identity);
  let scratch: string | undefined;
  let input: Awaited<ReturnType<LocalVideoStorage["openRange"]>> | undefined;
  try {
    signal.throwIfAborted();
    const root =
      process.env.TMPDIR ?? path.join(process.cwd(), ".orca-scratch");
    await mkdir(root, { recursive: true, mode: 0o700 });
    scratch = await mkdtemp(path.join(root, "selection-"));
    const filename = path.join(scratch, "source");
    input = await storage.openRange(source.key, null);
    signal.throwIfAborted();
    const stream = input.stream;
    const stop = () => stream.destroy();
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (input.size !== source.bytes || source.bytes > 2 * 1024 ** 3)
        throw Error("SOURCE_MISMATCH");
      const file = await open(filename, "wx", 0o600);
      try {
        let bytes = 0;
        const hash = createHash("sha256");
        for await (const chunk of stream) {
          signal.throwIfAborted();
          bytes += (chunk as Buffer).length;
          if (bytes > source.bytes) throw Error("SOURCE_MISMATCH");
          hash.update(chunk);
          await file.writeFile(chunk as Buffer);
        }
        signal.throwIfAborted();
        if (bytes !== source.bytes || hash.digest("hex") !== source.sha256)
          throw Error("SOURCE_MISMATCH");
      } finally {
        await file.close();
      }
    } finally {
      signal.removeEventListener("abort", stop);
      stream.destroy();
    }
    const previous = cache.get(identity);
    if (previous) {
      let valid = true;
      for (const [idx, frame] of previous.frames.entries()) {
        signal.throwIfAborted();
        try {
          const cached = await storage.openRange(frame.key, null);
          const stop = () => cached.stream.destroy();
          signal.addEventListener("abort", stop, { once: true });
          try {
            if (cached.size > 1048576) throw Error("CACHE_INVALID");
            const hash = createHash("sha256");
            for await (const chunk of cached.stream) {
              signal.throwIfAborted();
              hash.update(chunk);
            }
            if (hash.digest("hex") !== previous.hashes[idx]) valid = false;
          } finally {
            signal.removeEventListener("abort", stop);
            cached.stream.destroy();
          }
        } catch {
          valid = false;
        }
      }
      signal.throwIfAborted();
      if (valid) return previous.frames;
    }
    const probe = JSON.parse(
      await tool(
        "ffprobe",
        [
          "-v",
          "error",
          "-max_alloc",
          "67108864",
          "-format_whitelist",
          "mov,matroska,webm",
          "-protocol_whitelist",
          "file,pipe",
          "-select_streams",
          "v:0",
          "-show_entries",
          "format=duration:stream=width,height",
          "-of",
          "json",
          filename,
        ],
        signal,
      ),
    );
    const duration = Number(probe.format?.duration);
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > maxDuration ||
      !probe.streams?.length
    )
      throw Error("SELECTION_UNAVAILABLE");
    const width = Number(probe.streams[0].width),
      height = Number(probe.streams[0].height);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 8192 ||
      height > 8192 ||
      width * height > 33554432
    )
      throw Error("SELECTION_UNAVAILABLE");
    const frames: Frame[] = [];
    const images: Buffer[] = [];
    let total = 0;
    for (let idx = 0; idx < count; idx++) {
      signal.throwIfAborted();
      const output = path.join(scratch, `${idx}.jpg`);
      const diagnostic = await tool(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-loglevel",
          "info",
          "-threads",
          "1",
          "-filter_threads",
          "1",
          "-max_alloc",
          "67108864",
          "-format_whitelist",
          "mov,matroska,webm",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          String((idx * duration) / count),
          "-copyts",
          "-start_at_zero",
          "-i",
          filename,
          "-map",
          "0:v:0",
          "-an",
          "-sn",
          "-dn",
          "-vf",
          "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,showinfo",
          "-frames:v",
          "1",
          "-threads",
          "1",
          "-q:v",
          "4",
          "-fs",
          "1048576",
          output,
        ],
        signal,
      );
      const match = diagnostic.match(
        /n:\s*0\s+pts:.*?pts_time:([\d.e+-]+).*?s:(\d+)x(\d+)/,
      );
      if (!match) throw Error("SELECTION_UNAVAILABLE");
      const ms = Math.round(Number(match[1]) * 1000),
        width = Number(match[2]),
        height = Number(match[3]);
      if (
        !Number.isSafeInteger(ms) ||
        ms < 0 ||
        ms > duration * 1000 + 1 ||
        !width ||
        !height ||
        width > 640 ||
        height > 640
      )
        throw Error("SELECTION_UNAVAILABLE");
      const image = await readFile(output);
      total += image.length;
      if (
        image.length > 1048576 ||
        total > 8 * 1024 ** 2 ||
        image[0] !== 255 ||
        image[1] !== 216 ||
        image.at(-1) !== 217
      )
        throw Error("SELECTION_UNAVAILABLE");
      if (frames.some((f) => f.ms === ms)) continue;
      frames.push({
        idx: frames.length,
        ms,
        width,
        height,
        key: `${source.key.replace(/source\/original$/, "selection")}/${source.sha256}/v1-${count}-${maxDuration}/${idx}.jpg`,
      });
      images.push(image);
    }
    if (!frames.length) throw Error("SELECTION_UNAVAILABLE");
    // Nothing is exposed until ALL extraction/validation succeeds. No pipeline artifacts.
    for (const [idx, frame] of frames.entries()) {
      signal.throwIfAborted();
      const url = await storage.signPutUrl(frame.key, "image/jpeg", 60);
      const request = new Request(url, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: new Uint8Array(images[idx]),
        signal,
      });
      await storage.writeSignedPut(
        request,
        await storage.verifySignedRequest(request, frame.key),
      );
    }
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    signal.throwIfAborted();
    cache.set(identity, {
      frames,
      hashes: images.map((image) =>
        createHash("sha256").update(image).digest("hex"),
      ),
    });
    return frames;
  } finally {
    input?.stream.destroy();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    running.delete(identity);
  }
}
