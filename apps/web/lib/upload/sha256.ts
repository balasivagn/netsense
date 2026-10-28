/** A small incremental SHA-256 implementation for browser Blob slices. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, by: number) => (value >>> by) | (value << (32 - by));

export class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private bytes = 0;
  private finished = false;

  update(input: Uint8Array): this {
    if (this.finished) throw Error("SHA256_FINALIZED");
    this.bytes += input.byteLength;
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(64 - this.blockLength, input.length - offset);
      this.block.set(input.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.transform(this.block);
        this.blockLength = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (!this.finished) {
      const bits = BigInt(this.bytes) * 8n;
      this.block[this.blockLength++] = 0x80;
      if (this.blockLength > 56) {
        this.block.fill(0, this.blockLength);
        this.transform(this.block);
        this.blockLength = 0;
      }
      this.block.fill(0, this.blockLength, 56);
      for (let index = 0; index < 8; index++)
        this.block[63 - index] = Number((bits >> BigInt(index * 8)) & 0xffn);
      this.transform(this.block);
      this.finished = true;
    }
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private transform(block: Uint8Array) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index++) {
      const at = index * 4;
      words[index] = (block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3];
    }
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15];
      const b = words[index - 2];
      words[index] = (words[index - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + words[index - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

export type HashableBlob = Pick<Blob, "size" | "slice">;

/** Reads one Blob slice at a time; it never calls arrayBuffer on the whole file. */
export async function sha256Blob(
  blob: HashableBlob,
  options: { chunkSize?: number; signal?: AbortSignal; onProgress?: (hashedBytes: number) => void } = {},
): Promise<string> {
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw Error("INVALID_CHUNK_SIZE");
  const hash = new IncrementalSha256();
  for (let start = 0; start < blob.size; start += chunkSize) {
    if (options.signal?.aborted) throw new DOMException("Hash cancelled", "AbortError");
    const bytes = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + chunkSize)).arrayBuffer());
    if (options.signal?.aborted) throw new DOMException("Hash cancelled", "AbortError");
    hash.update(bytes);
    options.onProgress?.(Math.min(blob.size, start + bytes.byteLength));
  }
  return hash.digestHex();
}
