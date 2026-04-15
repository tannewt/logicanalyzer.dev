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

import {search} from '../../base/binary_search';
import {Time} from '../../base/time';
import {Trace} from '../../public/trace';
import {PerfettoPlugin} from '../../public/plugin';
import {TrackRenderContext, TrackRenderer} from '../../public/track';
import {TrackNode} from '../../public/workspace';
import {LONG, NUM, STR} from '../../trace_processor/query_result';
import {
  Decoder,
  DecodedEvent,
  MultiSignalDecoder,
  SignalData,
  signalToEdgeEvents,
  runDecoderStack,
} from './decoder';
import {PulseWidthDecoder} from './pulse_width_decoder';
import {NeoPixelDecoder} from './neopixel_decoder';
import {SpiDecoder} from './spi_decoder';
import {I2cDecoder} from './i2c_decoder';
import TraceProcessorTrackPlugin from '../dev.perfetto.TraceProcessorTrack';
import TrackEventPlugin from '../dev.perfetto.TrackEvent';
import {
  CounterTrackInfo,
  DecoderOption,
  MultiSignalConfig,
  ProtocolDecoderConfigTab,
  TrackDecoderAssignment,
} from './config_tab';

const PLUGIN_ID = 'dev.perfetto.ProtocolDecoder';
const TAB_URI = `${PLUGIN_ID}#config`;

// A single-signal decoder stack (e.g., NeoPixel: edges -> bits -> colors).
interface SingleSignalStack {
  readonly kind: 'single';
  readonly name: string;
  readonly description: string;
  readonly decoders: Decoder[];
}

// A multi-signal decoder (e.g., SPI: CLK + MOSI + MISO + CS).
interface MultiSignalStack {
  readonly kind: 'multi';
  readonly name: string;
  readonly description: string;
  readonly decoder: MultiSignalDecoder;
}

type DecoderStackConfig = SingleSignalStack | MultiSignalStack;

const DECODER_STACKS: DecoderStackConfig[] = [
  {
    kind: 'single',
    name: 'NeoPixel (WS2812B)',
    description: 'Decode WS2812B NeoPixel LED data',
    decoders: [new PulseWidthDecoder(), new NeoPixelDecoder()],
  },
  {
    kind: 'multi',
    name: 'SPI',
    description: 'Decode SPI bus transactions',
    decoder: new SpiDecoder(),
  },
  {
    kind: 'multi',
    name: 'I2C',
    description: 'Decode I2C bus transactions',
    decoder: new I2cDecoder(),
  },
];

function buildDecoderOptions(): DecoderOption[] {
  const options: DecoderOption[] = [];
  for (const stack of DECODER_STACKS) {
    if (stack.kind === 'single') {
      // Use the last decoder's ID as the stack identifier.
      const last = stack.decoders[stack.decoders.length - 1];
      options.push({id: last.id, name: stack.name, kind: 'single'});
    } else {
      options.push({
        id: stack.decoder.id,
        name: stack.name,
        kind: 'multi',
        roles: stack.decoder.signalRoles.map((r) => ({
          name: r.name,
          required: r.required,
        })),
      });
    }
  }
  return options;
}

// Tracks a decoded TrackNode and which raw track nodes were reparented
// under it so they can be restored on cleanup.
interface AppliedDecoding {
  // Serialized connection state — used to detect when wiring changed.
  connectionKey: string;
  // The top-level decoded track node (may contain nested children).
  node: TrackNode;
  reparentedRawNodes: Array<{
    node: TrackNode;
    originalParent: TrackNode | null;
  }>;
  // Generation used to build unique URIs for this decoding.
  generation: number;
}

export default class ProtocolDecoderPlugin implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly dependencies = [TraceProcessorTrackPlugin, TrackEventPlugin];
  static readonly description =
    'Protocol decoder for logic analyzer signals. ' +
    'Stacks decoders to decode raw digital signals into higher-level data.';

  // Map from graph node ID -> applied decoding state.
  private appliedDecodings = new Map<string, AppliedDecoding>();
  // Monotonically increasing generation counter to make track URIs unique
  // across apply cycles (the track registry throws on duplicate URIs and
  // the public API doesn't expose a way to unregister).
  private generation = 0;

  async onTraceLoad(trace: Trace): Promise<void> {
    const decoderOptions = buildDecoderOptions();

    trace.tabs.registerTab({
      uri: TAB_URI,
      isEphemeral: false,
      content: new ProtocolDecoderConfigTab(decoderOptions, {
        getDigitalTracks: () => this.getDigitalTracks(trace),
        applyConfig: (singles, multis) =>
          this.applyConfig(trace, singles, multis),
      }),
    });

    // Show the tab if there are digital tracks.
    const tracks = await this.getDigitalTracks(trace);
    if (tracks.length > 0) {
      trace.tabs.addDefaultTab(TAB_URI);
    }
  }

  private async getDigitalTracks(trace: Trace): Promise<CounterTrackInfo[]> {
    const result = await trace.engine.query(`
      SELECT
        ct.id as track_id,
        ct.name as track_name
      FROM counter_track ct
      JOIN _counter_track_summary using (id)
      WHERE ct.type IN (
        'saleae_digital',
        'global_counter_track_event',
        'process_counter_track_event',
        'thread_counter_track_event'
      )
    `);

    const tracks: CounterTrackInfo[] = [];
    const it = result.iter({track_id: NUM, track_name: STR});
    for (; it.valid(); it.next()) {
      tracks.push({trackId: it.track_id, name: it.track_name});
    }
    return tracks;
  }

  private async readSignalData(
    trace: Trace,
    trackId: number,
  ): Promise<SignalData> {
    const result = await trace.engine.query(`
      SELECT ts, value
      FROM counter
      WHERE track_id = ${trackId}
      ORDER BY ts ASC
    `);

    const timestamps: bigint[] = [];
    const values: number[] = [];
    const it = result.iter({ts: LONG, value: NUM});
    for (; it.valid(); it.next()) {
      timestamps.push(it.ts);
      values.push(it.value);
    }
    return {timestamps, values};
  }

  // Remove a single decoding and restore its raw tracks.
  private removeDecoding(trace: Trace, graphNodeId: string) {
    const decoding = this.appliedDecodings.get(graphNodeId);
    if (!decoding) return;
    // Restore reparented raw nodes. If the original parent was removed
    // (e.g. it was itself a decoded node), fall back to the workspace.
    for (const raw of decoding.reparentedRawNodes) {
      raw.node.remove();
      if (raw.originalParent?.parent) {
        raw.originalParent.addChildInOrder(raw.node);
      } else {
        trace.defaultWorkspace.addChildInOrder(raw.node);
      }
    }
    decoding.node.remove();
    this.appliedDecodings.delete(graphNodeId);
  }

  // Build a connection key string for a single-signal assignment.
  private static singleConnectionKey(a: TrackDecoderAssignment): string {
    return `single:${a.decoderId}:${a.trackId}`;
  }

  // Build a connection key string for a multi-signal config.
  private static multiConnectionKey(c: MultiSignalConfig): string {
    const roles = [...c.roleAssignments.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([r, t]) => `${r}=${t}`)
      .join(',');
    return `multi:${c.decoderId}:${roles}`;
  }

  private async applyConfig(
    trace: Trace,
    singleAssignments: TrackDecoderAssignment[],
    multiConfigs: MultiSignalConfig[],
  ): Promise<void> {
    // Build the desired state: graph node ID -> connection key.
    const desired = new Map<string, string>();
    for (const a of singleAssignments) {
      desired.set(a.graphNodeId, ProtocolDecoderPlugin.singleConnectionKey(a));
    }
    for (const c of multiConfigs) {
      desired.set(c.graphNodeId, ProtocolDecoderPlugin.multiConnectionKey(c));
    }

    // Remove decodings that are no longer desired or whose wiring changed.
    for (const [graphNodeId, applied] of this.appliedDecodings) {
      const newKey = desired.get(graphNodeId);
      if (newKey === applied.connectionKey) continue;
      this.removeDecoding(trace, graphNodeId);
    }

    // Apply single-signal decoder assignments (skip unchanged).
    for (const assignment of singleAssignments) {
      const key = ProtocolDecoderPlugin.singleConnectionKey(assignment);
      const existing = this.appliedDecodings.get(assignment.graphNodeId);
      if (existing?.connectionKey === key) continue;

      this.generation++;
      const stack = DECODER_STACKS.find((s) => {
        if (s.kind !== 'single') return false;
        const last = s.decoders[s.decoders.length - 1];
        return last.id === assignment.decoderId;
      });
      if (stack?.kind !== 'single') continue;

      const track: CounterTrackInfo = {
        trackId: assignment.trackId,
        name: assignment.trackName,
      };
      await this.decodeSingleSignalTrack(
        trace,
        track,
        stack,
        assignment.graphNodeId,
      );
    }

    // Apply multi-signal decoder configs (skip unchanged).
    for (const config of multiConfigs) {
      const key = ProtocolDecoderPlugin.multiConnectionKey(config);
      const existing = this.appliedDecodings.get(config.graphNodeId);
      if (existing?.connectionKey === key) continue;

      this.generation++;
      const stack = DECODER_STACKS.find((s) => {
        return s.kind === 'multi' && s.decoder.id === config.decoderId;
      });
      if (stack?.kind !== 'multi') continue;

      await this.decodeMultiSignalFromConfig(
        trace,
        stack,
        config,
        config.graphNodeId,
      );
    }
  }

  private async decodeSingleSignalTrack(
    trace: Trace,
    track: CounterTrackInfo,
    stack: SingleSignalStack,
    graphNodeId: string,
  ): Promise<void> {
    const signal = await this.readSignalData(trace, track.trackId);
    if (signal.timestamps.length === 0) return;

    const edgeEvents = signalToEdgeEvents(signal.timestamps, signal.values);
    const results = runDecoderStack(edgeEvents, stack.decoders);
    const rawNode = this.findTrackNode(trace, track.trackId);

    // Build all track nodes first, then assemble the hierarchy with the
    // highest-level decoder on top.  Desired order (top to bottom):
    //   additional tracks (e.g. Color) → primary tracks (last decoder
    //   first, e.g. Hex then Pulse Width) → raw counter track.

    // Collect primary decoder nodes in stack order.
    const primaryNodes: TrackNode[] = [];
    // Collect additional nodes keyed by decoder index.
    const additionalNodes: TrackNode[] = [];

    for (let di = 0; di < stack.decoders.length; di++) {
      const decoder = stack.decoders[di];
      const events = results.get(decoder);
      if (!events || events.length === 0) continue;

      const result = this.registerDecodedTrack(
        trace,
        decoder.id,
        decoder.name,
        decoder.description,
        events,
        track.name,
        [],
        decoder.createTrackRenderer
          ? decoder.createTrackRenderer(trace, '', events)
          : undefined,
      );
      primaryNodes.push(result.node);

      if (decoder.createAdditionalTrackRenderers) {
        const additional = decoder.createAdditionalTrackRenderers(
          trace,
          '',
          events,
        );
        for (const [suffix, renderer] of additional) {
          const extraResult = this.registerDecodedTrack(
            trace,
            `${decoder.id}_${suffix.toLowerCase()}`,
            `${decoder.name} ${suffix}`,
            decoder.description,
            events,
            track.name,
            [],
            renderer,
          );
          additionalNodes.push(extraResult.node);
        }
      }
    }

    // Assemble nested hierarchy (each level is parent of the next):
    //   Color → Hex → Pulse Width → Raw counter track.
    const allNodes = [...additionalNodes, ...primaryNodes.reverse()];
    if (allNodes.length === 0) return;

    // Remove all nodes from the workspace — registerDecodedTrack added
    // them via addChildInOrder, but we need to rebuild the hierarchy.
    for (const node of allNodes) {
      node.remove();
    }

    const topNode = allNodes[0];

    // Place the top node where the raw track was.
    const rawParent = rawNode?.parent ?? null;
    if (rawNode) {
      const parent = rawNode.parent;
      if (parent) {
        parent.addChildBefore(topNode, rawNode);
      } else {
        trace.defaultWorkspace.addChildInOrder(topNode);
      }
      rawNode.remove();
    } else {
      trace.defaultWorkspace.addChildInOrder(topNode);
    }

    // Nest each subsequent node as a child of the previous one.
    let parentNode = topNode;
    for (let i = 1; i < allNodes.length; i++) {
      parentNode.addChildLast(allNodes[i]);
      parentNode = allNodes[i];
    }
    const reparentedRawNodes: AppliedDecoding['reparentedRawNodes'] = [];
    if (rawNode) {
      parentNode.addChildLast(rawNode);
      reparentedRawNodes.push({node: rawNode, originalParent: rawParent});
    }
    this.appliedDecodings.set(graphNodeId, {
      connectionKey: ProtocolDecoderPlugin.singleConnectionKey({
        graphNodeId,
        decoderId: stack.decoders[stack.decoders.length - 1].id,
        trackId: track.trackId,
        trackName: track.name,
      }),
      node: topNode,
      reparentedRawNodes,
      generation: this.generation,
    });
  }

  private async decodeMultiSignalFromConfig(
    trace: Trace,
    stack: MultiSignalStack,
    config: MultiSignalConfig,
    graphNodeId: string,
  ): Promise<void> {
    const decoder = stack.decoder;

    // Check required roles are assigned.
    for (const role of decoder.signalRoles) {
      if (role.required && !config.roleAssignments.has(role.name)) {
        return;
      }
    }

    // Read signal data for assigned roles.
    const signals = new Map<string, SignalData>();
    const trackNames: string[] = [];
    const rawNodes: TrackNode[] = [];

    for (const [roleName, trackId] of config.roleAssignments) {
      const signal = await this.readSignalData(trace, trackId);
      signals.set(roleName, signal);

      const tracks = await this.getDigitalTracks(trace);
      const trackInfo = tracks.find((t) => t.trackId === trackId);
      if (trackInfo) trackNames.push(trackInfo.name);

      const node = this.findTrackNode(trace, trackId);
      if (node) rawNodes.push(node);
    }

    const events = decoder.decode(signals);
    if (events.length === 0) return;

    const result = this.registerDecodedTrack(
      trace,
      decoder.id,
      decoder.name,
      decoder.description,
      events,
      trackNames.join(', '),
      rawNodes,
      decoder.createTrackRenderer
        ? decoder.createTrackRenderer(trace, '', events)
        : undefined,
    );
    this.appliedDecodings.set(graphNodeId, {
      connectionKey: ProtocolDecoderPlugin.multiConnectionKey(config),
      node: result.node,
      reparentedRawNodes: result.reparentedRawNodes,
      generation: this.generation,
    });
  }

  private registerDecodedTrack(
    trace: Trace,
    decoderId: string,
    decoderName: string,
    decoderDescription: string,
    events: DecodedEvent[],
    sourceTrackName: string,
    rawNodes: TrackNode[],
    customRenderer?: TrackRenderer,
  ): {
    node: TrackNode;
    reparentedRawNodes: AppliedDecoding['reparentedRawNodes'];
  } {
    const uri = `${PLUGIN_ID}#${decoderId}_${sourceTrackName}_g${this.generation}`;

    const renderer = customRenderer ?? new DefaultDecodedTrackRenderer(events);

    trace.tracks.registerTrack({
      uri,
      renderer,
      description: decoderDescription,
    });

    const trackNode = new TrackNode({
      uri,
      name: `${decoderName}: ${sourceTrackName}`,
    });

    const reparentedRawNodes: AppliedDecoding['reparentedRawNodes'] = [];

    if (rawNodes.length > 0) {
      const firstRaw = rawNodes[0];
      const parent = firstRaw.parent;
      if (parent) {
        parent.addChildBefore(trackNode, firstRaw);
      } else {
        trace.defaultWorkspace.addChildInOrder(trackNode);
      }
      for (const rawNode of rawNodes) {
        const originalParent = rawNode.parent ?? null;
        reparentedRawNodes.push({node: rawNode, originalParent});
        rawNode.remove();
        trackNode.addChildLast(rawNode);
      }
    } else {
      trace.defaultWorkspace.addChildInOrder(trackNode);
    }

    return {node: trackNode, reparentedRawNodes};
  }

  private findTrackNode(trace: Trace, trackId: number): TrackNode | undefined {
    for (const node of trace.defaultWorkspace.flatTracks) {
      if (!node.uri) continue;
      const track = trace.tracks.getTrack(node.uri);
      if (track?.tags?.trackIds?.includes(trackId)) {
        return node;
      }
    }
    return undefined;
  }
}

// Simple renderer that draws decoded events as labeled rectangles.
class DefaultDecodedTrackRenderer implements TrackRenderer {
  private readonly events: DecodedEvent[];
  private readonly timestamps: bigint[];

  constructor(events: DecodedEvent[]) {
    this.events = events;
    this.timestamps = events.map((e) => e.ts);
  }

  getHeight(): number {
    return 24;
  }

  render({ctx, size, timescale, visibleWindow}: TrackRenderContext): void {
    const startTime = visibleWindow.start.toTime('floor');
    const endTime = visibleWindow.end.toTime('ceil');

    const startIdx = Math.max(0, search(this.timestamps, startTime));
    let endIdx = search(this.timestamps, endTime);
    if (endIdx < 0) return;
    endIdx = Math.min(endIdx + 1, this.events.length - 1);

    ctx.font = '10px Roboto Condensed, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = startIdx; i <= endIdx; i++) {
      const event = this.events[i];
      const x1 = timescale.timeToPx(Time.fromRaw(event.ts));
      const x2 =
        event.dur > 0n
          ? timescale.timeToPx(Time.fromRaw(event.ts + event.dur))
          : x1 + 8;
      const w = Math.max(x2 - x1, 1);

      ctx.fillStyle = this.eventColor(event);
      ctx.fillRect(x1, 2, w, size.height - 4);

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.strokeRect(x1, 2, w, size.height - 4);

      if (w > 15) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillText(event.label, x1 + w / 2, size.height / 2);
      }
    }
  }

  private eventColor(event: DecodedEvent): string {
    const label = event.label;
    if (label === 'RESET' || label === 'STOP') {
      return 'rgba(200, 50, 50, 0.4)';
    }
    if (label === 'START' || label === 'Sr' || label === 'CS') {
      return 'rgba(50, 180, 50, 0.4)';
    }
    if (label.includes('NAK')) {
      return 'rgba(200, 100, 50, 0.4)';
    }
    return 'rgba(50, 100, 200, 0.4)';
  }
}
