// Copyright (C) 2025 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {SerialTransport} from './sump_protocol';

export interface SerialPortOptions {
  baudRate: number;
}

// WebSerial-based transport for SUMP communication.
//
// Uses a single background read loop to avoid the orphaned-promise bug:
// if you race reader.read() against a timeout and the timeout wins, the
// pending read() still resolves later and silently consumes the next
// chunk of data. Instead, we pump reader.read() continuously into a
// buffer and let the high-level methods drain from that buffer.
export class WebSerialTransport implements SerialTransport {
  private port: SerialPort | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

  // Incoming data buffer fed by the background read loop.
  private rxBuf: Uint8Array[] = [];
  private rxLen = 0;
  // Resolves when new data arrives (or the stream closes).
  private rxWaiter: (() => void) | undefined;
  private readLoopRunning = false;

  get connected(): boolean {
    return this.port !== undefined && this.readLoopRunning;
  }

  get portInfo(): SerialPortInfo | undefined {
    return this.port?.getInfo();
  }

  async connect(options: SerialPortOptions): Promise<void> {
    if (this.connected) {
      await this.disconnect();
    }
    const port = await navigator.serial.requestPort();
    await port.open({
      baudRate: options.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    this.port = port;
    if (!port.readable || !port.writable) {
      throw new Error('Serial port is not readable/writable');
    }
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.rxBuf = [];
    this.rxLen = 0;
    this.startReadLoop();
  }

  async disconnect(): Promise<void> {
    this.readLoopRunning = false;
    // Wake any pending waiter so reads can unblock.
    this.rxWaiter?.();
    this.rxWaiter = undefined;
    try {
      this.reader?.releaseLock();
    } catch (_) {
      // Ignore.
    }
    try {
      this.writer?.releaseLock();
    } catch (_) {
      // Ignore.
    }
    this.reader = undefined;
    this.writer = undefined;
    try {
      await this.port?.close();
    } catch (_) {
      // Ignore errors on close.
    }
    this.port = undefined;
    this.rxBuf = [];
    this.rxLen = 0;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(data);
  }

  // Read available data, waiting up to timeoutMs. Returns whatever was
  // received (may be empty if timeout expires with no data).
  async read(timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;

    // Wait for at least some data or timeout.
    while (this.rxLen === 0 && Date.now() < deadline) {
      await this.waitForData(deadline - Date.now());
    }

    // If we got some data, keep waiting for more until silence (no new
    // data for the remaining time). This handles multi-part responses
    // like metadata.
    if (this.rxLen > 0) {
      while (Date.now() < deadline) {
        const before = this.rxLen;
        await this.waitForData(Math.min(deadline - Date.now(), 100));
        if (this.rxLen === before) break; // No new data arrived.
      }
    }

    return this.drainBuffer();
  }

  // Read at least minBytes, or until timeoutMs expires.
  async readWithMinBytes(
    minBytes: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (this.rxLen < minBytes && Date.now() < deadline) {
      await this.waitForData(deadline - Date.now());
    }
    return this.drainBuffer();
  }

  // Read data until the sentinel byte sequence is found. Returns all
  // data up to (but not including) the sentinel. The sentinel may span
  // chunk boundaries. Times out after timeoutMs if sentinel is never seen.
  // The onData callback fires on each chunk for progress tracking.
  async readUntilSentinel(
    sentinel: Uint8Array,
    timeoutMs: number,
    onData?: (chunk: Uint8Array, totalBytes: number) => void,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    // Bytes from the end of the previous chunk that could be a partial
    // sentinel match — we hold them back until we can confirm they aren't
    // the start of the sentinel.
    let tail = new Uint8Array(0);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const before = this.rxLen;
      await this.waitForData(deadline - Date.now());
      if (this.rxLen === before) {
        // No new data and we haven't hit deadline yet — keep waiting.
        if (Date.now() < deadline) continue;
        break;
      }

      const data = this.drainBuffer();
      if (data.length === 0) continue;

      // Combine the held-back tail with new data to check for the
      // sentinel spanning the boundary.
      const combined = new Uint8Array(tail.length + data.length);
      combined.set(tail, 0);
      combined.set(data, tail.length);

      const pos = findSequence(combined, sentinel);
      if (pos !== -1) {
        // Found sentinel. Keep everything before it.
        if (pos > 0) {
          const keep = combined.slice(0, pos);
          chunks.push(keep);
          totalLen += keep.length;
          onData?.(keep, totalLen);
        }
        break;
      }

      // No sentinel yet. Emit everything except the last
      // (sentinel.length - 1) bytes, which could be a partial match.
      const holdBack = sentinel.length - 1;
      const safeEnd = combined.length - holdBack;
      if (safeEnd > 0) {
        const safe = combined.slice(0, safeEnd);
        chunks.push(safe);
        totalLen += safe.length;
        onData?.(safe, totalLen);
        tail = combined.slice(safeEnd);
      } else {
        tail = combined;
      }
    }

    // If we timed out, flush any held-back tail bytes.
    if (tail.length > 0) {
      chunks.push(tail);
      totalLen += tail.length;
    }

    if (chunks.length === 0) return new Uint8Array(0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  // --- Internal helpers ---

  // Background loop: continuously reads from the serial port and
  // appends to the rx buffer. Only one reader.read() is ever pending.
  private startReadLoop(): void {
    this.readLoopRunning = true;
    const loop = async () => {
      while (this.readLoopRunning && this.reader) {
        try {
          const {value, done} = await this.reader.read();
          if (done || !value) {
            this.readLoopRunning = false;
            break;
          }
          this.rxBuf.push(value);
          this.rxLen += value.length;
          // Wake anyone waiting for data.
          this.rxWaiter?.();
          this.rxWaiter = undefined;
        } catch (_) {
          this.readLoopRunning = false;
          break;
        }
      }
      // Wake waiters so they don't hang after disconnect.
      this.rxWaiter?.();
      this.rxWaiter = undefined;
    };
    // Fire and forget - runs in the background.
    void loop();
  }

  // Wait up to timeoutMs for new data to arrive in the rx buffer.
  private waitForData(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.rxWaiter = undefined;
        resolve();
      }, timeoutMs);

      this.rxWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // Drain all buffered data into a single Uint8Array and clear.
  private drainBuffer(): Uint8Array {
    if (this.rxLen === 0) return new Uint8Array(0);
    const result = new Uint8Array(this.rxLen);
    let offset = 0;
    for (const chunk of this.rxBuf) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    this.rxBuf = [];
    this.rxLen = 0;
    return result;
  }
}

// Find the first occurrence of `needle` in `haystack`. Returns the byte
// offset or -1 if not found.
function findSequence(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  const end = haystack.length - needle.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
