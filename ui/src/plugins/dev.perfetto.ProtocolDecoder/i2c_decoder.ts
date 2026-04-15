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

import {
  DecodedEvent,
  MultiSignalDecoder,
  SignalData,
  SignalRole,
  findEdges,
  findRisingEdges,
  getValueAtTime,
} from './decoder';

export interface I2cConditionData {
  condition: 'start' | 'stop' | 'repeated_start';
}

export interface I2cAddressData {
  address: number;
  read: boolean;
  ack: boolean;
}

export interface I2cByteData {
  value: number;
  ack: boolean;
  byteIndex: number;
}

// Decodes I2C bus transactions from SCL and SDA signals.
//
// I2C protocol:
// - Start condition: SDA falls while SCL is high
// - Stop condition: SDA rises while SCL is high
// - Data is sampled on the rising edge of SCL
// - 8 data bits followed by 1 ACK/NACK bit per byte
// - First byte after start is 7-bit address + R/W bit
// - ACK = SDA low on 9th clock, NACK = SDA high
export class I2cDecoder implements MultiSignalDecoder {
  readonly id = 'i2c';
  readonly name = 'I2C';
  readonly description = 'Decodes I2C bus data from SCL and SDA signals.';
  readonly outputType = 'i2c_bytes';

  readonly signalRoles: ReadonlyArray<SignalRole> = [
    {
      name: 'scl',
      description: 'Serial Clock',
      required: true,
      namePatterns: ['scl', 'i2c_scl', 'clock', 'clk', 'i2c_clk'],
    },
    {
      name: 'sda',
      description: 'Serial Data',
      required: true,
      namePatterns: ['sda', 'i2c_sda', 'data', 'i2c_data'],
    },
  ];

  decode(signals: Map<string, SignalData>): DecodedEvent[] {
    const scl = signals.get('scl');
    const sda = signals.get('sda');
    if (!scl || !sda) return [];

    const output: DecodedEvent[] = [];

    // Find start/stop conditions: SDA transitions while SCL is high.
    const sdaEdges = findEdges(sda);
    const conditions: Array<{
      ts: bigint;
      type: 'start' | 'stop';
    }> = [];

    for (const edge of sdaEdges) {
      const sclVal = getValueAtTime(scl, edge.ts);
      if (sclVal !== 1) continue;

      if (edge.from === 1 && edge.to === 0) {
        // SDA falling while SCL high = START condition.
        conditions.push({ts: edge.ts, type: 'start'});
      } else if (edge.from === 0 && edge.to === 1) {
        // SDA rising while SCL high = STOP condition.
        conditions.push({ts: edge.ts, type: 'stop'});
      }
    }

    if (conditions.length === 0) return [];

    // Find all rising edges of SCL for data sampling.
    const sclRisingEdges = findRisingEdges(scl);

    // Process each transaction (start -> stop).
    for (let ci = 0; ci < conditions.length; ci++) {
      const cond = conditions[ci];

      if (cond.type === 'stop') {
        output.push({
          ts: cond.ts,
          dur: 0n,
          label: 'STOP',
          data: {condition: 'stop'} as I2cConditionData,
        });
        continue;
      }

      // This is a START or REPEATED START.
      const isRepeatedStart = ci > 0 && conditions[ci - 1].type === 'start';
      output.push({
        ts: cond.ts,
        dur: 0n,
        label: isRepeatedStart ? 'Sr' : 'START',
        data: {
          condition: isRepeatedStart ? 'repeated_start' : 'start',
        } as I2cConditionData,
      });

      // Find the end of this transaction.
      const nextCondIdx = conditions.findIndex(
        (c, idx) => idx > ci && (c.type === 'stop' || c.type === 'start'),
      );
      const txnEnd =
        nextCondIdx >= 0
          ? conditions[nextCondIdx].ts
          : scl.timestamps[scl.timestamps.length - 1];

      // Find SCL rising edges within this transaction.
      const dataEdges = sclRisingEdges.filter((t) => t > cond.ts && t < txnEnd);

      // Decode bytes: 8 data bits + 1 ACK bit = 9 clocks per byte.
      let isFirstByte = true;
      let byteIndex = 0;

      for (let bitStart = 0; bitStart + 9 <= dataEdges.length; bitStart += 9) {
        // Sample 8 data bits (MSB first).
        let value = 0;
        const byteStartTs = dataEdges[bitStart];
        for (let b = 0; b < 8; b++) {
          const sdaVal = getValueAtTime(sda, dataEdges[bitStart + b]);
          value = (value << 1) | sdaVal;
        }

        // Sample ACK bit (9th clock).
        const ackTs = dataEdges[bitStart + 8];
        const ack = getValueAtTime(sda, ackTs) === 0; // ACK = SDA low
        const endTs =
          bitStart + 9 < dataEdges.length
            ? dataEdges[bitStart + 9]
            : ackTs + 1n;

        if (isFirstByte) {
          // First byte is address (bits 7:1) + R/W (bit 0).
          const address = value >> 1;
          const read = (value & 1) === 1;
          output.push({
            ts: byteStartTs,
            dur: endTs - byteStartTs,
            label: `${read ? 'R' : 'W'} 0x${address.toString(16).padStart(2, '0').toUpperCase()} ${ack ? 'ACK' : 'NAK'}`,
            data: {address, read, ack} as I2cAddressData,
          });
          isFirstByte = false;
        } else {
          output.push({
            ts: byteStartTs,
            dur: endTs - byteStartTs,
            label: `0x${value.toString(16).padStart(2, '0').toUpperCase()} ${ack ? 'ACK' : 'NAK'}`,
            data: {value, ack, byteIndex} as I2cByteData,
          });
        }
        byteIndex++;
      }
    }

    return output;
  }
}
