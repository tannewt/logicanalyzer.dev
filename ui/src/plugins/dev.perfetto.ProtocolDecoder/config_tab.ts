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

import m from 'mithril';
import {Tab} from '../../public/tab';
import {Button, ButtonVariant} from '../../widgets/button';
import {
  Connection,
  Node,
  NodeGraph,
  NodeGraphApi,
  NodePort,
} from '../../widgets/nodegraph';

// Mirrors the types from index.ts — kept minimal to avoid circular deps.
export interface CounterTrackInfo {
  trackId: number;
  name: string;
}

export interface DecoderOption {
  readonly id: string;
  readonly name: string;
  readonly kind: 'single' | 'multi';
  // For multi-signal decoders, the role names (e.g., 'CLK', 'MOSI').
  readonly roles?: ReadonlyArray<{name: string; required: boolean}>;
}

// Per-track configuration: which decoder to apply.
export interface TrackDecoderAssignment {
  graphNodeId: string; // Node graph ID (e.g., "decoder_0")
  trackId: number;
  trackName: string;
  decoderId: string; // '' means no decoder
}

// For multi-signal decoders: which track fills each role.
export interface MultiSignalConfig {
  graphNodeId: string; // Node graph ID
  decoderId: string;
  // Role name -> trackId.
  roleAssignments: Map<string, number>;
}

export interface ConfigTabCallbacks {
  getDigitalTracks(): Promise<CounterTrackInfo[]>;
  applyConfig(
    singleAssignments: TrackDecoderAssignment[],
    multiConfigs: MultiSignalConfig[],
  ): Promise<void>;
}

// Node ID conventions:
//   Signal nodes: "signal_<trackId>"
//   Decoder nodes: "decoder_<index>"
const SIGNAL_PREFIX = 'signal_';
const DECODER_PREFIX = 'decoder_';
const STORAGE_KEY = 'perfetto.protocolDecoder.graphState';

interface DecoderNodeState {
  decoderOption: DecoderOption;
  x: number;
  y: number;
}

// Serializable form of the graph state.  Connections reference signal
// nodes by *track name* (not trackId) so they survive across traces
// where the same signals get different IDs.
interface SerializedState {
  signalPositions: Array<{
    name: string;
    x: number;
    y: number;
  }>;
  decoderNodes: Array<{
    id: string;
    decoderId: string;
    x: number;
    y: number;
  }>;
  connections: Array<{
    fromSignalName: string;
    fromPort: number;
    toNode: string;
    toPort: number;
  }>;
  nextDecoderIndex: number;
}

export class ProtocolDecoderConfigTab implements Tab {
  private tracks: CounterTrackInfo[] = [];
  private loaded = false;

  // Signal node positions, keyed by track name (survives across traces).
  private signalPositions = new Map<string, {x: number; y: number}>();

  // Decoder nodes the user has added to the graph.
  private decoderNodes = new Map<string, DecoderNodeState>();
  private nextDecoderIndex = 0;

  // Connections between signal outputs and decoder inputs.
  private connections: Connection[] = [];

  // Selection state.
  private selectedNodes = new Set<string>();

  private graphApi?: NodeGraphApi;

  constructor(
    private readonly decoders: DecoderOption[],
    private readonly callbacks: ConfigTabCallbacks,
  ) {
    this.loadTracks();
  }

  getTitle(): string {
    return 'Protocol Decoders';
  }

  private async loadTracks() {
    this.tracks = await this.callbacks.getDigitalTracks();
    this.restoreState();
    this.loaded = true;
    // Auto-apply restored connections.
    if (this.connections.length > 0) {
      this.apply();
    }
    m.redraw();
  }

  render(): m.Children {
    if (!this.loaded) {
      return m('.pf-protocol-decoder-config', 'Loading tracks...');
    }
    if (this.tracks.length === 0) {
      return m('.pf-protocol-decoder-config', 'No digital tracks found.');
    }

    const nodes = this.buildNodes();
    return m(NodeGraph, {
      nodes,
      connections: this.connections,
      fillHeight: true,
      selectedNodeIds: this.selectedNodes,
      onConnect: (conn: Connection) => {
        this.connections.push(conn);
        this.saveState();
        this.apply();
        m.redraw();
      },
      onConnectionRemove: (index: number) => {
        this.connections.splice(index, 1);
        this.saveState();
        this.apply();
        m.redraw();
      },
      onNodeMove: (nodeId: string, x: number, y: number) => {
        if (nodeId.startsWith(SIGNAL_PREFIX)) {
          const trackId = Number(nodeId.slice(SIGNAL_PREFIX.length));
          const track = this.tracks.find((t) => t.trackId === trackId);
          if (track) {
            this.signalPositions.set(track.name, {x, y});
          }
        } else {
          const decoder = this.decoderNodes.get(nodeId);
          if (decoder) {
            decoder.x = x;
            decoder.y = y;
          }
        }
        this.saveState();
        m.redraw();
      },
      onNodeSelect: (nodeId: string) => {
        this.selectedNodes.clear();
        this.selectedNodes.add(nodeId);
        m.redraw();
      },
      onSelectionClear: () => {
        this.selectedNodes.clear();
        m.redraw();
      },
      onNodeRemove: (nodeId: string) => {
        if (nodeId.startsWith(DECODER_PREFIX)) {
          this.decoderNodes.delete(nodeId);
          // Remove connections involving this node.
          this.connections = this.connections.filter(
            (c) => c.fromNode !== nodeId && c.toNode !== nodeId,
          );
          this.selectedNodes.delete(nodeId);
          this.saveState();
          m.redraw();
        }
      },
      onReady: (api: NodeGraphApi) => {
        this.graphApi = api;
      },
      toolbarItems: this.renderToolbar(),
    } satisfies Partial<import('../../widgets/nodegraph').NodeGraphAttrs>);
  }

  private renderToolbar(): m.Children {
    return this.decoders.map((d) =>
      m(Button, {
        label: `+ ${d.name}`,
        variant: ButtonVariant.Outlined,
        onclick: () => this.addDecoderNode(d),
      }),
    );
  }

  private addDecoderNode(decoder: DecoderOption) {
    const id = `${DECODER_PREFIX}${this.nextDecoderIndex++}`;
    // Place to the right of signal nodes.
    let pos = {x: 300, y: 50};
    if (this.graphApi) {
      pos = this.graphApi.findPlacementForNode({
        id,
        inputs: this.buildDecoderInputPorts(decoder),
        outputs: [],
      });
    }
    this.decoderNodes.set(id, {
      decoderOption: decoder,
      x: pos.x,
      y: pos.y,
    });
    this.saveState();
    m.redraw();
  }

  private buildNodes(): Node[] {
    const nodes: Node[] = [];

    // Signal track nodes on the left.
    this.tracks.forEach((track, i) => {
      const pos = this.signalPositions.get(track.name) ?? {
        x: 50,
        y: 50 + i * 60,
      };
      nodes.push({
        id: `${SIGNAL_PREFIX}${track.trackId}`,
        x: pos.x,
        y: pos.y,
        hue: 200,
        titleBar: {title: track.name},
        outputs: [{direction: 'right'}],
      });
    });

    // Decoder nodes.
    for (const [nodeId, state] of this.decoderNodes) {
      const decoder = state.decoderOption;
      nodes.push({
        id: nodeId,
        x: state.x,
        y: state.y,
        hue: decoder.kind === 'single' ? 120 : 30,
        titleBar: {title: decoder.name},
        inputs: this.buildDecoderInputPorts(decoder),
        content: this.renderDecoderContent(decoder),
      });
    }

    return nodes;
  }

  private buildDecoderInputPorts(decoder: DecoderOption): NodePort[] {
    if (decoder.kind === 'multi' && decoder.roles) {
      return decoder.roles.map((role) => ({
        content: `${role.name}${role.required ? ' *' : ''}`,
        direction: 'left' as const,
      }));
    }
    // Single-signal decoder: one input.
    return [{content: 'Signal', direction: 'left' as const}];
  }

  private renderDecoderContent(decoder: DecoderOption): m.Children {
    if (decoder.kind === 'multi' && decoder.roles) {
      return m(
        'div',
        {style: {padding: '4px', fontSize: '11px', color: '#888'}},
        `${decoder.roles.filter((r) => r.required).length} required signals`,
      );
    }
    return m(
      'div',
      {style: {padding: '4px', fontSize: '11px', color: '#888'}},
      'Connect a digital signal',
    );
  }

  private async apply() {
    const singleAssignments: TrackDecoderAssignment[] = [];
    const multiConfigs: MultiSignalConfig[] = [];

    for (const [nodeId, state] of this.decoderNodes) {
      const decoder = state.decoderOption;

      if (decoder.kind === 'single') {
        // Find the connection to this decoder's input port (port 0).
        const conn = this.connections.find(
          (c) => c.toNode === nodeId && c.toPort === 0,
        );
        if (!conn) continue;

        const trackId = this.signalNodeToTrackId(conn.fromNode);
        if (trackId === undefined) continue;

        const track = this.tracks.find((t) => t.trackId === trackId);
        if (!track) continue;

        singleAssignments.push({
          graphNodeId: nodeId,
          trackId: track.trackId,
          trackName: track.name,
          decoderId: decoder.id,
        });
      } else if (decoder.kind === 'multi' && decoder.roles) {
        const roleAssignments = new Map<string, number>();

        for (let portIdx = 0; portIdx < decoder.roles.length; portIdx++) {
          const role = decoder.roles[portIdx];
          const conn = this.connections.find(
            (c) => c.toNode === nodeId && c.toPort === portIdx,
          );
          if (!conn) continue;

          const trackId = this.signalNodeToTrackId(conn.fromNode);
          if (trackId === undefined) continue;
          roleAssignments.set(role.name, trackId);
        }

        if (roleAssignments.size > 0) {
          multiConfigs.push({
            graphNodeId: nodeId,
            decoderId: decoder.id,
            roleAssignments,
          });
        }
      }
    }

    await this.callbacks.applyConfig(singleAssignments, multiConfigs);
  }

  private signalNodeToTrackId(nodeId: string): number | undefined {
    if (!nodeId.startsWith(SIGNAL_PREFIX)) return undefined;
    return Number(nodeId.slice(SIGNAL_PREFIX.length));
  }

  // Map a track name to its signal node ID in the current trace.
  private trackNameToSignalNodeId(name: string): string | undefined {
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return undefined;
    return `${SIGNAL_PREFIX}${track.trackId}`;
  }

  // Map a signal node ID to the track name for serialization.
  private signalNodeIdToTrackName(nodeId: string): string | undefined {
    const trackId = this.signalNodeToTrackId(nodeId);
    if (trackId === undefined) return undefined;
    return this.tracks.find((t) => t.trackId === trackId)?.name;
  }

  private saveState() {
    const state: SerializedState = {
      signalPositions: [],
      decoderNodes: [],
      connections: [],
      nextDecoderIndex: this.nextDecoderIndex,
    };

    for (const [name, pos] of this.signalPositions) {
      state.signalPositions.push({name, x: pos.x, y: pos.y});
    }

    for (const [id, node] of this.decoderNodes) {
      state.decoderNodes.push({
        id,
        decoderId: node.decoderOption.id,
        x: node.x,
        y: node.y,
      });
    }

    for (const conn of this.connections) {
      const signalName = this.signalNodeIdToTrackName(conn.fromNode);
      if (signalName === undefined) continue;
      state.connections.push({
        fromSignalName: signalName,
        fromPort: conn.fromPort,
        toNode: conn.toNode,
        toPort: conn.toPort,
      });
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or unavailable — silently ignore.
    }
  }

  private restoreState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const state: SerializedState = JSON.parse(raw);

      // Restore signal positions.
      if (state.signalPositions) {
        for (const saved of state.signalPositions) {
          this.signalPositions.set(saved.name, {x: saved.x, y: saved.y});
        }
      }

      // Restore decoder nodes, matching by decoder ID.
      for (const saved of state.decoderNodes) {
        const decoder = this.decoders.find((d) => d.id === saved.decoderId);
        if (!decoder) continue;
        this.decoderNodes.set(saved.id, {
          decoderOption: decoder,
          x: saved.x,
          y: saved.y,
        });
      }
      this.nextDecoderIndex = state.nextDecoderIndex;

      // Restore connections, resolving signal names to current track IDs.
      for (const saved of state.connections) {
        const fromNode = this.trackNameToSignalNodeId(saved.fromSignalName);
        if (fromNode === undefined) continue;
        // Only restore if the target decoder node exists.
        if (!this.decoderNodes.has(saved.toNode)) continue;
        this.connections.push({
          fromNode,
          fromPort: saved.fromPort,
          toNode: saved.toNode,
          toPort: saved.toPort,
        });
      }
    } catch {
      // Corrupted data — start fresh.
    }
  }
}
