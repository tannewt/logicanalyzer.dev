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

// SUMP protocol command bytes.
const CMD_RESET = 0x00;
const CMD_RUN = 0x01;
const CMD_ID = 0x02;
const CMD_METADATA = 0x04;
const CMD_SET_FORMAT = 0x05;

const CMD_SET_DIVIDER = 0x80;
const CMD_SET_FLAGS = 0x82;
const CMD_SET_PIN_MAP = 0x83;
const CMD_SET_ENABLE_PIN = 0x84;
const CMD_SET_READ_COUNT_EXT = 0x85;

const CMD_SET_TRIG_MASK_0 = 0xc0;
const CMD_SET_TRIG_VAL_0 = 0xc1;
const CMD_SET_TRIG_CFG_0 = 0xc2;

// Output format constants.
export const OUTPUT_FORMAT_RAW = 0x00;
export const OUTPUT_FORMAT_PERFETTO = 0x01;

// Flag bits for CMD_SET_FLAGS.
export const FLAG_DEMUX = 1 << 0;
export const FLAG_NOISE_FILTER = 1 << 1;
export const FLAG_DISABLE_GROUP1 = 1 << 2;
export const FLAG_DISABLE_GROUP2 = 1 << 3;
export const FLAG_DISABLE_GROUP3 = 1 << 4;
export const FLAG_DISABLE_GROUP4 = 1 << 5;
export const FLAG_CLOCK_EXTERNAL = 1 << 6;
export const FLAG_INVERT_EXT_CLOCK = 1 << 7;
export const FLAG_RLE = 1 << 8;

// Metadata key types (high nibble encodes type).
// 0x0x = null-terminated string, 0x2x = uint32 BE, 0x4x = uint8.
const META_END = 0x00;

export interface DeviceMetadata {
  deviceName: string;
  firmwareVersion: string;
  numProbes: number;
  sampleMemoryBytes: number;
  maxSampleRateHz: number;
  protocolVersion: number;
  capabilities: string;
  outputFormat: number;
  maxGpio: number;
}

function defaultMetadata(): DeviceMetadata {
  return {
    deviceName: '',
    firmwareVersion: '',
    numProbes: 0,
    sampleMemoryBytes: 0,
    maxSampleRateHz: 0,
    protocolVersion: 0,
    capabilities: '',
    outputFormat: 0,
    maxGpio: 54,
  };
}

export interface TriggerConfig {
  mask: number;
  value: number;
  // Config word: bit 27 = start, bits 15:11 = delay, bits 1:0 = level/channel.
  config: number;
}

export interface PinMapping {
  channel: number;
  gpio: number; // -1 means disabled
}

// Encodes a 5-byte long command (cmd + 4 LE data bytes).
function longCommand(cmd: number, value: number): Uint8Array {
  const buf = new Uint8Array(5);
  buf[0] = cmd;
  buf[1] = value & 0xff;
  buf[2] = (value >>> 8) & 0xff;
  buf[3] = (value >>> 16) & 0xff;
  buf[4] = (value >>> 24) & 0xff;
  return buf;
}

// Encodes a 1-byte short command.
function shortCommand(cmd: number): Uint8Array {
  return new Uint8Array([cmd]);
}

// Encodes a 2-byte short command with one data byte (e.g. set format).
function shortCommandWithData(cmd: number, data: number): Uint8Array {
  return new Uint8Array([cmd, data]);
}

// Parse the metadata blob returned by the device after CMD_METADATA.
export function parseMetadata(data: Uint8Array): DeviceMetadata {
  const meta = defaultMetadata();
  let i = 0;
  while (i < data.length) {
    const key = data[i++];
    if (key === META_END) break;

    const keyType = key & 0xe0; // Top 3 bits encode type.
    if (keyType === 0x00) {
      // Null-terminated string.
      let str = '';
      while (i < data.length && data[i] !== 0x00) {
        str += String.fromCharCode(data[i++]);
      }
      i++; // Skip null terminator.
      switch (key) {
        case 0x01:
          meta.deviceName = str;
          break;
        case 0x03:
          meta.firmwareVersion = str;
          break;
        case 0x04:
          meta.capabilities = str;
          break;
      }
    } else if (keyType === 0x20) {
      // uint32, big-endian.
      if (i + 4 > data.length) break;
      const val =
        (data[i] << 24) |
        (data[i + 1] << 16) |
        (data[i + 2] << 8) |
        data[i + 3];
      i += 4;
      switch (key) {
        case 0x20:
          meta.numProbes = val >>> 0;
          break;
        case 0x21:
          meta.sampleMemoryBytes = val >>> 0;
          break;
        case 0x23:
          meta.maxSampleRateHz = val >>> 0;
          break;
        case 0x24:
          meta.protocolVersion = val >>> 0;
          break;
        case 0x25:
          meta.maxGpio = val >>> 0;
          break;
      }
    } else if (keyType === 0x40) {
      // uint8.
      if (i >= data.length) break;
      const val = data[i++];
      switch (key) {
        case 0x42:
          meta.outputFormat = val;
          break;
      }
    } else {
      // Unknown type, cannot continue parsing safely.
      break;
    }
  }
  return meta;
}

// Interface for the underlying serial transport.
export interface SerialTransport {
  write(data: Uint8Array): Promise<void>;
  read(timeout: number): Promise<Uint8Array>;
  readWithMinBytes(minBytes: number, timeout: number): Promise<Uint8Array>;
  readUntilSentinel(
    sentinel: Uint8Array,
    timeoutMs: number,
    onData?: (chunk: Uint8Array, totalBytes: number) => void,
  ): Promise<Uint8Array>;
}

// High-level SUMP protocol driver.
export class SumpProtocol {
  constructor(private readonly transport: SerialTransport) {}

  async reset(): Promise<void> {
    // Send 5 reset bytes as recommended by the protocol to flush any
    // partial long-command state.
    const resets = new Uint8Array(5);
    resets.fill(CMD_RESET);
    await this.transport.write(resets);
    // Small delay to let device process.
    await new Promise((r) => setTimeout(r, 50));
  }

  async identify(): Promise<string> {
    await this.transport.write(shortCommand(CMD_ID));
    const resp = await this.transport.readWithMinBytes(4, 1000);
    return new TextDecoder().decode(resp.slice(0, 4));
  }

  async getMetadata(): Promise<DeviceMetadata> {
    await this.transport.write(shortCommand(CMD_METADATA));
    // Metadata response is variable-length, terminated by 0x00.
    // Read with a generous timeout and buffer.
    const resp = await this.transport.read(2000);
    return parseMetadata(resp);
  }

  async setDivider(divider: number): Promise<void> {
    await this.transport.write(longCommand(CMD_SET_DIVIDER, divider));
  }

  // Configure sample rate. Returns the actual rate that will be used.
  async setSampleRate(
    desiredHz: number,
    maxSampleRateHz: number,
  ): Promise<number> {
    if (desiredHz <= 0 || desiredHz > maxSampleRateHz) {
      desiredHz = maxSampleRateHz;
    }
    const divider = Math.round(maxSampleRateHz / desiredHz) - 1;
    await this.setDivider(Math.max(0, divider));
    return maxSampleRateHz / (divider + 1);
  }

  async setReadCount(readCount: number): Promise<void> {
    // Use the extended read count command (0x85) which takes a full
    // 32-bit sample count, avoiding the 262144-sample limit of the
    // standard 0x81 command.
    await this.transport.write(
      longCommand(CMD_SET_READ_COUNT_EXT, readCount >>> 0),
    );
  }

  async setFlags(flags: number): Promise<void> {
    await this.transport.write(longCommand(CMD_SET_FLAGS, flags));
  }

  async setOutputFormat(format: number): Promise<void> {
    await this.transport.write(shortCommandWithData(CMD_SET_FORMAT, format));
  }

  async setPinMapping(channel: number, gpio: number): Promise<void> {
    const gpioVal = gpio < 0 ? 0xff : gpio;
    const val = (channel & 0xff) | ((gpioVal & 0xff) << 8);
    await this.transport.write(longCommand(CMD_SET_PIN_MAP, val));
  }

  async setEnablePin(gpio: number, activeLow: boolean): Promise<void> {
    const gpioVal = gpio < 0 ? 0xff : gpio;
    const flags = activeLow ? 1 : 0;
    const val = (gpioVal & 0xff) | ((flags & 0xff) << 8);
    await this.transport.write(longCommand(CMD_SET_ENABLE_PIN, val));
  }

  async setTrigger(stage: number, config: TriggerConfig): Promise<void> {
    if (stage < 0 || stage > 3)
      {throw new Error(`Invalid trigger stage ${stage}`);}
    const offset = stage * 4; // Stages are at offsets 0, 4, 8, 12.
    await this.transport.write(
      longCommand(CMD_SET_TRIG_MASK_0 + offset, config.mask),
    );
    await this.transport.write(
      longCommand(CMD_SET_TRIG_VAL_0 + offset, config.value),
    );
    await this.transport.write(
      longCommand(CMD_SET_TRIG_CFG_0 + offset, config.config),
    );
  }

  async run(): Promise<void> {
    await this.transport.write(shortCommand(CMD_RUN));
  }
}
