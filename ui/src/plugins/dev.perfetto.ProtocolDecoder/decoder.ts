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

// A decoded event produced by a decoder. Each event spans a time range
// and carries decoder-specific data.
export interface DecodedEvent {
  // Start timestamp in trace processor time units (nanoseconds).
  ts: bigint;
  // Duration in nanoseconds.
  dur: bigint;
  // Human-readable label for display.
  label: string;
  // Decoder-specific payload.
  data: unknown;
}

// A decoder transforms a sequence of DecodedEvents into a new sequence.
// The first decoder in a stack receives "edge" events from raw signal data.
// Subsequent decoders receive the output of the previous decoder.
export interface Decoder {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  // The type of events this decoder consumes (e.g., 'edges', 'bits').
  readonly inputType: string;

  // The type of events this decoder produces (e.g., 'bits', 'neopixel').
  readonly outputType: string;

  // Transform input events into decoded output events.
  decode(input: DecodedEvent[]): DecodedEvent[];

  // Create a custom track renderer for the decoded output.
  // If undefined, a default slice track is used.
  createTrackRenderer?(
    trace: Trace,
    uri: string,
    events: DecodedEvent[],
  ): TrackRenderer;

  // Create additional track renderers beyond the primary one.
  // Each entry maps a suffix name to its renderer.
  createAdditionalTrackRenderers?(
    trace: Trace,
    uri: string,
    events: DecodedEvent[],
  ): Map<string, TrackRenderer>;
}

// Raw signal data from a single counter track.
export interface SignalData {
  timestamps: bigint[];
  values: number[];
}

// Describes a signal input that a multi-signal decoder requires.
export interface SignalRole {
  // Role name used as the key in the signals map (e.g., 'clk', 'mosi').
  readonly name: string;
  // Human-readable description.
  readonly description: string;
  // Whether this signal is required for decoding.
  readonly required: boolean;
  // Name patterns to auto-match counter track names (case-insensitive).
  readonly namePatterns: ReadonlyArray<string>;
}

// A decoder that correlates multiple digital signals (e.g., CLK + DATA).
export interface MultiSignalDecoder {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  // The named signal inputs this decoder needs.
  readonly signalRoles: ReadonlyArray<SignalRole>;

  // The type of events this decoder produces.
  readonly outputType: string;

  // Decode correlated signals into events.
  decode(signals: Map<string, SignalData>): DecodedEvent[];

  // Create a custom track renderer for the decoded output.
  createTrackRenderer?(
    trace: Trace,
    uri: string,
    events: DecodedEvent[],
  ): TrackRenderer;
}

// Given a signal's data, return its value at a specific timestamp.
// Uses binary search to find the last sample at or before the given time.
export function getValueAtTime(signal: SignalData, t: bigint): number {
  const {timestamps, values} = signal;
  if (timestamps.length === 0 || t < timestamps[0]) return 0;

  let lo = 0;
  let hi = timestamps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timestamps[mid] <= t) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return values[lo];
}

// Find all timestamps where a signal transitions from one value to another.
// Returns edges as {ts, from, to} objects.
export interface SignalEdge {
  ts: bigint;
  from: number;
  to: number;
}

export function findEdges(signal: SignalData): SignalEdge[] {
  const edges: SignalEdge[] = [];
  const {timestamps, values} = signal;
  for (let i = 1; i < timestamps.length; i++) {
    if (values[i] !== values[i - 1]) {
      edges.push({ts: timestamps[i], from: values[i - 1], to: values[i]});
    }
  }
  return edges;
}

// Find rising edges (0 -> 1) in a signal.
export function findRisingEdges(signal: SignalData): bigint[] {
  return findEdges(signal)
    .filter((e) => e.from === 0 && e.to === 1)
    .map((e) => e.ts);
}

// Find falling edges (1 -> 0) in a signal.
export function findFallingEdges(signal: SignalData): bigint[] {
  return findEdges(signal)
    .filter((e) => e.from === 1 && e.to === 0)
    .map((e) => e.ts);
}

// Convert raw counter track data (ts/value pairs) into edge events
// suitable as input to the first decoder in a stack.
export function signalToEdgeEvents(
  timestamps: bigint[],
  values: number[],
): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  for (let i = 0; i < timestamps.length - 1; i++) {
    const ts = timestamps[i];
    const dur = timestamps[i + 1] - ts;
    const value = values[i];
    events.push({
      ts,
      dur,
      label: String(value),
      data: {value},
    });
  }
  // Add the last sample with zero duration (it extends to the end of trace).
  if (timestamps.length > 0) {
    const lastIdx = timestamps.length - 1;
    events.push({
      ts: timestamps[lastIdx],
      dur: 0n,
      label: String(values[lastIdx]),
      data: {value: values[lastIdx]},
    });
  }
  return events;
}

// Run a stack of decoders sequentially, feeding each decoder's output
// as the next decoder's input.
export function runDecoderStack(
  input: DecodedEvent[],
  decoders: Decoder[],
): Map<Decoder, DecodedEvent[]> {
  const results = new Map<Decoder, DecodedEvent[]>();
  let current = input;
  for (const decoder of decoders) {
    current = decoder.decode(current);
    results.set(decoder, current);
  }
  return results;
}
