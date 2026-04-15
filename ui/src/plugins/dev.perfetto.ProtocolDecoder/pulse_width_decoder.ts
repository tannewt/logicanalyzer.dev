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

import {Decoder, DecodedEvent} from './decoder';

// Pulse-width encoding thresholds in nanoseconds.
export interface PulseWidthConfig {
  // High pulse shorter than this is a "0" bit.
  zeroMaxNs: bigint;
  // High pulse longer than this is a "1" bit.
  oneMinNs: bigint;
  // Low pulse longer than this is a reset/frame boundary.
  resetMinNs: bigint;
}

// Default config for WS2812B / NeoPixel timing.
const WS2812B_CONFIG: PulseWidthConfig = {
  zeroMaxNs: 500n, // T0H max ~500ns
  oneMinNs: 500n, // T1H min ~500ns
  resetMinNs: 50000n, // Reset > 50us
};

export interface BitData {
  bit: number; // 0 or 1
}

export interface ResetData {
  reset: true;
}

// Decodes digital signal edges into bits using pulse-width encoding.
// A high pulse shorter than the threshold is a 0, longer is a 1.
// A long low pulse is a reset/frame boundary.
export class PulseWidthDecoder implements Decoder {
  readonly id = 'pulse_width';
  readonly name = 'Pulse Width';
  readonly description =
    'Decodes pulse-width encoded signals into bits. ' +
    'Short high pulses are 0, long high pulses are 1.';
  readonly inputType = 'edges';
  readonly outputType = 'bits';

  constructor(private readonly config: PulseWidthConfig = WS2812B_CONFIG) {}

  decode(input: DecodedEvent[]): DecodedEvent[] {
    const output: DecodedEvent[] = [];

    for (const event of input) {
      const edgeData = event.data as {value: number};
      const dur = event.dur;

      if (edgeData.value === 1) {
        // High pulse: classify as bit 0 or 1 based on width.
        const bit = dur >= this.config.oneMinNs ? 1 : 0;
        output.push({
          ts: event.ts,
          dur,
          label: String(bit),
          data: {bit} as BitData,
        });
      } else if (edgeData.value === 0 && dur >= this.config.resetMinNs) {
        // Long low pulse: reset/frame boundary.
        output.push({
          ts: event.ts,
          dur,
          label: 'RESET',
          data: {reset: true} as ResetData,
        });
      }
      // Short low pulses (between bits) are ignored — they're just
      // the return-to-zero part of the encoding.
    }

    return output;
  }
}
