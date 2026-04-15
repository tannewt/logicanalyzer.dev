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

import {Trace} from '../../public/trace';
import {TrackRenderer} from '../../public/track';
import {Decoder, DecodedEvent} from './decoder';
import {BitData, ResetData} from './pulse_width_decoder';
import {
  NeoPixelTrackRenderer,
  NeoPixelHexTrackRenderer,
} from './neopixel_track';

export interface NeoPixelColor {
  r: number;
  g: number;
  b: number;
  pixelIndex: number;
}

// Decodes pulse-width bits into NeoPixel RGB color values.
// WS2812B sends 24 bits per pixel in GRB order, MSB first.
// A reset signal marks the end of a frame (all pixels updated).
export class NeoPixelDecoder implements Decoder {
  readonly id = 'neopixel';
  readonly name = 'NeoPixel (WS2812B)';
  readonly description =
    'Decodes pulse-width bits into NeoPixel RGB colors. ' +
    '24 bits per pixel in GRB order.';
  readonly inputType = 'bits';
  readonly outputType = 'neopixel';

  decode(input: DecodedEvent[]): DecodedEvent[] {
    const output: DecodedEvent[] = [];
    let bitBuffer: number[] = [];
    let pixelIndex = 0;
    let pixelStartTs: bigint | undefined;

    for (const event of input) {
      const resetData = event.data as ResetData;
      if (resetData.reset) {
        // Flush any partial pixel data.
        if (bitBuffer.length > 0) {
          const color = this.bitsToColor(bitBuffer, pixelIndex);
          if (color && pixelStartTs !== undefined) {
            output.push({
              ts: pixelStartTs,
              dur: event.ts - pixelStartTs,
              label: this.colorToHex(color),
              data: color,
            });
          }
        }

        // Emit reset event and start new frame.
        output.push({
          ts: event.ts,
          dur: event.dur,
          label: 'RESET',
          data: {reset: true} as ResetData,
        });

        bitBuffer = [];
        pixelIndex = 0;
        pixelStartTs = undefined;
        continue;
      }

      const bitData = event.data as BitData;
      if (bitData.bit === undefined) continue;

      if (bitBuffer.length === 0) {
        pixelStartTs = event.ts;
      }
      bitBuffer.push(bitData.bit);

      // We have a complete pixel (24 bits = 8G + 8R + 8B).
      if (bitBuffer.length === 24) {
        const color = this.bitsToColor(bitBuffer, pixelIndex);
        if (color && pixelStartTs !== undefined) {
          const endTs = event.ts + event.dur;
          output.push({
            ts: pixelStartTs,
            dur: endTs - pixelStartTs,
            label: this.colorToHex(color),
            data: color,
          });
        }
        bitBuffer = [];
        pixelIndex++;
        pixelStartTs = undefined;
      }
    }

    return output;
  }

  private bitsToColor(
    bits: number[],
    pixelIndex: number,
  ): NeoPixelColor | undefined {
    if (bits.length < 24) return undefined;

    // WS2812B: GRB order, MSB first.
    let g = 0;
    let r = 0;
    let b = 0;
    for (let i = 0; i < 8; i++) {
      g = (g << 1) | bits[i];
      r = (r << 1) | bits[8 + i];
      b = (b << 1) | bits[16 + i];
    }

    return {r, g, b, pixelIndex};
  }

  private colorToHex(color: NeoPixelColor): string {
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  }

  createTrackRenderer(
    trace: Trace,
    _uri: string,
    events: DecodedEvent[],
  ): TrackRenderer {
    return new NeoPixelHexTrackRenderer(trace, events);
  }

  createAdditionalTrackRenderers(
    trace: Trace,
    _uri: string,
    events: DecodedEvent[],
  ): Map<string, TrackRenderer> {
    return new Map([['Color', new NeoPixelTrackRenderer(trace, events)]]);
  }
}
