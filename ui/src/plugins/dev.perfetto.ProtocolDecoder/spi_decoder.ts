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
  findRisingEdges,
  findFallingEdges,
  getValueAtTime,
  findEdges,
} from './decoder';

export interface SpiByteData {
  mosi?: number;
  miso?: number;
  byteIndex: number;
}

export interface SpiTransactionData {
  transaction: true;
  byteCount: number;
}

// SPI mode determines clock polarity (CPOL) and clock phase (CPHA).
// Mode 0 (CPOL=0, CPHA=0): sample on rising edge, idle low
// Mode 1 (CPOL=0, CPHA=1): sample on falling edge, idle low
// Mode 2 (CPOL=1, CPHA=0): sample on falling edge, idle high
// Mode 3 (CPOL=1, CPHA=1): sample on rising edge, idle high
export type SpiMode = 0 | 1 | 2 | 3;

export interface SpiConfig {
  mode: SpiMode;
  bitsPerWord: number;
  msbFirst: boolean;
  csActiveLow: boolean;
}

const DEFAULT_SPI_CONFIG: SpiConfig = {
  mode: 0,
  bitsPerWord: 8,
  msbFirst: true,
  csActiveLow: true,
};

// Decodes SPI bus transactions from CLK, MOSI, MISO, and CS signals.
// Data is sampled on the appropriate clock edge based on SPI mode.
// CS frames transactions; without CS, all data is one transaction.
export class SpiDecoder implements MultiSignalDecoder {
  readonly id = 'spi';
  readonly name = 'SPI';
  readonly description =
    'Decodes SPI bus data from CLK, MOSI, MISO, and CS signals.';
  readonly outputType = 'spi_bytes';

  readonly signalRoles: ReadonlyArray<SignalRole> = [
    {
      name: 'clk',
      description: 'Serial clock',
      required: true,
      namePatterns: ['clk', 'sck', 'sclk', 'clock', 'spi_clk', 'spi_sck'],
    },
    {
      name: 'mosi',
      description: 'Master Out Slave In (data from controller)',
      required: false,
      namePatterns: ['mosi', 'sdi', 'si', 'din', 'copi', 'spi_mosi'],
    },
    {
      name: 'miso',
      description: 'Master In Slave Out (data from peripheral)',
      required: false,
      namePatterns: ['miso', 'sdo', 'so', 'dout', 'cipo', 'spi_miso'],
    },
    {
      name: 'cs',
      description: 'Chip Select (frames transactions)',
      required: false,
      namePatterns: ['cs', 'ss', 'nss', 'cs_n', 'ss_n', 'csel', 'spi_cs'],
    },
  ];

  constructor(private readonly config: SpiConfig = DEFAULT_SPI_CONFIG) {}

  decode(signals: Map<string, SignalData>): DecodedEvent[] {
    const clk = signals.get('clk');
    if (!clk) return [];

    const mosi = signals.get('mosi');
    const miso = signals.get('miso');
    const cs = signals.get('cs');

    // Determine which clock edge to sample on based on SPI mode.
    const sampleOnRising = this.config.mode === 0 || this.config.mode === 3;
    const sampleEdges = sampleOnRising
      ? findRisingEdges(clk)
      : findFallingEdges(clk);

    if (sampleEdges.length === 0) return [];

    // If CS is available, find transaction boundaries.
    const transactions = cs
      ? this.findTransactions(cs)
      : [{start: sampleEdges[0], end: sampleEdges[sampleEdges.length - 1]}];

    const output: DecodedEvent[] = [];

    for (const txn of transactions) {
      // Filter sample edges within this transaction.
      const txnEdges = sampleEdges.filter(
        (t) => t >= txn.start && t <= txn.end,
      );
      if (txnEdges.length === 0) continue;

      // Emit transaction boundary event.
      if (cs) {
        output.push({
          ts: txn.start,
          dur: txn.end - txn.start,
          label: 'CS',
          data: {transaction: true, byteCount: 0} as SpiTransactionData,
        });
      }

      // Sample data on each clock edge and group into bytes.
      const mosiBits: number[] = [];
      const misoBits: number[] = [];
      let byteStartTs = txnEdges[0];
      let byteIndex = 0;

      for (let i = 0; i < txnEdges.length; i++) {
        const t = txnEdges[i];

        if (mosiBits.length === 0) {
          byteStartTs = t;
        }

        if (mosi) mosiBits.push(getValueAtTime(mosi, t));
        if (miso) misoBits.push(getValueAtTime(miso, t));

        const bitsCollected = Math.max(mosiBits.length, misoBits.length);
        if (bitsCollected >= this.config.bitsPerWord) {
          const endTs = i + 1 < txnEdges.length ? txnEdges[i + 1] : t + 1n;
          const mosiVal = mosi
            ? this.bitsToValue(mosiBits.splice(0, this.config.bitsPerWord))
            : undefined;
          const misoVal = miso
            ? this.bitsToValue(misoBits.splice(0, this.config.bitsPerWord))
            : undefined;

          output.push({
            ts: byteStartTs,
            dur: endTs - byteStartTs,
            label: this.formatByte(mosiVal, misoVal),
            data: {mosi: mosiVal, miso: misoVal, byteIndex} as SpiByteData,
          });
          byteIndex++;
        }
      }

      // Update transaction byte count.
      if (cs) {
        const txnEvent = output.find(
          (e) =>
            e.ts === txn.start && (e.data as SpiTransactionData).transaction,
        );
        if (txnEvent) {
          (txnEvent.data as SpiTransactionData).byteCount = byteIndex;
        }
      }
    }

    return output;
  }

  private findTransactions(
    cs: SignalData,
  ): Array<{start: bigint; end: bigint}> {
    const edges = findEdges(cs);
    const transactions: Array<{start: bigint; end: bigint}> = [];
    let activeStart: bigint | undefined;

    // CS active means the signal is at the active level.
    const activeLevel = this.config.csActiveLow ? 0 : 1;

    for (const edge of edges) {
      if (edge.to === activeLevel) {
        activeStart = edge.ts;
      } else if (activeStart !== undefined) {
        transactions.push({start: activeStart, end: edge.ts});
        activeStart = undefined;
      }
    }

    // Handle CS still active at end of trace.
    if (activeStart !== undefined && cs.timestamps.length > 0) {
      transactions.push({
        start: activeStart,
        end: cs.timestamps[cs.timestamps.length - 1],
      });
    }

    return transactions;
  }

  private bitsToValue(bits: number[]): number {
    let val = 0;
    if (this.config.msbFirst) {
      for (const bit of bits) {
        val = (val << 1) | bit;
      }
    } else {
      for (let i = bits.length - 1; i >= 0; i--) {
        val = (val << 1) | bits[i];
      }
    }
    return val;
  }

  private formatByte(mosi?: number, miso?: number): string {
    const parts: string[] = [];
    if (mosi !== undefined) {
      parts.push(`TX:0x${mosi.toString(16).padStart(2, '0').toUpperCase()}`);
    }
    if (miso !== undefined) {
      parts.push(`RX:0x${miso.toString(16).padStart(2, '0').toUpperCase()}`);
    }
    return parts.join(' ') || '??';
  }
}
