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
import {App} from '../../public/app';
import {Button, ButtonVariant} from '../../widgets/button';
import {Section} from '../../widgets/section';
import {Spinner} from '../../widgets/spinner';
import {Select} from '../../widgets/select';
import {WebSerialTransport} from './serial_transport';
import {
  DeviceMetadata,
  OUTPUT_FORMAT_PERFETTO,
  SumpProtocol,
} from './sump_protocol';

const MAX_CHANNELS = 16;

// Common baud rates for SUMP devices.
const BAUD_RATES = [115200, 230400, 460800, 921600, 1000000, 2000000];

interface ChannelConfig {
  enabled: boolean;
  gpio: number; // -1 = disabled/unassigned
  label: string;
}

type CaptureState =
  | 'idle'
  | 'connecting'
  | 'configuring'
  | 'capturing'
  | 'loading';

// Persistent state that survives page navigation. Created once in the
// plugin's onActivate and passed into the page component on each render.
export class LogicAnalyzerState {
  readonly transport = new WebSerialTransport();
  protocol: SumpProtocol | undefined;
  metadata: DeviceMetadata | undefined;

  baudRate = 115200;
  sampleRateHz = 1000000;
  captureDurationMs = 100;
  captureState: CaptureState = 'idle';
  statusMessage = '';
  bytesReceived = 0;

  enableGpio = -1;
  enableActiveLow = false;

  channels: ChannelConfig[] = [];

  constructor() {
    this.channels.push({enabled: false, gpio: -1, label: 'D0'});
  }

  // Ensure there is exactly one trailing "None" row (up to MAX_CHANNELS).
  trimChannels() {
    // Remove excess trailing None channels, keeping one.
    while (
      this.channels.length > 1 &&
      this.channels[this.channels.length - 1].gpio < 0 &&
      this.channels[this.channels.length - 2].gpio < 0
    ) {
      this.channels.pop();
    }
    // Add a None row if the last channel is assigned and we're under the limit.
    if (
      this.channels.length < MAX_CHANNELS &&
      this.channels[this.channels.length - 1].gpio >= 0
    ) {
      const i = this.channels.length;
      this.channels.push({enabled: false, gpio: -1, label: `D${i}`});
    }
  }
}

export interface LogicAnalyzerPageAttrs {
  app: App;
  state: LogicAnalyzerState;
}

export class LogicAnalyzerPage
  implements m.ClassComponent<LogicAnalyzerPageAttrs>
{
  private app!: App;
  private s!: LogicAnalyzerState;

  constructor({attrs}: m.CVnode<LogicAnalyzerPageAttrs>) {
    this.app = attrs.app;
    this.s = attrs.state;
  }

  view({attrs}: m.CVnode<LogicAnalyzerPageAttrs>) {
    this.app = attrs.app;
    this.s = attrs.state;
    return m(
      '.pf-logic-analyzer-page',
      m(
        '.pf-logic-analyzer-page__content',
        this.renderConnection(),
        this.s.transport.connected &&
          this.s.metadata &&
          this.renderDeviceInfo(),
        this.s.transport.connected && this.renderPinConfig(),
        this.s.transport.connected && this.renderCaptureSettings(),
        this.s.transport.connected && this.renderEnablePin(),
        this.s.transport.connected && this.renderCaptureControls(),
      ),
    );
  }

  private renderConnection(): m.Children {
    const connected = this.s.transport.connected;
    return m(
      Section,
      {title: 'Connection'},
      m(
        '.pf-logic-analyzer-row',
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Baud Rate'),
          m(
            Select,
            {
              disabled: connected,
              value: String(this.s.baudRate),
              onchange: (e: Event) => {
                this.s.baudRate = Number((e.target as HTMLSelectElement).value);
              },
            },
            BAUD_RATES.map((rate) =>
              m('option', {value: String(rate)}, rate.toLocaleString()),
            ),
          ),
        ),
        connected
          ? m(Button, {
              label: 'Disconnect',
              icon: 'link_off',
              variant: ButtonVariant.Filled,
              onclick: () => this.disconnect(),
            })
          : m(Button, {
              label: 'Connect',
              icon: 'usb',
              variant: ButtonVariant.Filled,
              onclick: () => this.connect(),
            }),
      ),
      this.s.captureState === 'connecting' && m(Spinner),
      this.s.statusMessage &&
        m(
          '.pf-logic-analyzer-status',
          {
            className: this.s.statusMessage.startsWith('Error') ? 'error' : '',
          },
          this.s.statusMessage,
        ),
    );
  }

  private renderDeviceInfo(): m.Children {
    const meta = this.s.metadata!;
    return m(
      Section,
      {title: 'Device Info'},
      m(
        '.pf-logic-analyzer-info',
        m('.pf-logic-analyzer-info-row', m('b', 'Name: '), meta.deviceName),
        m(
          '.pf-logic-analyzer-info-row',
          m('b', 'Firmware: '),
          meta.firmwareVersion,
        ),
        m(
          '.pf-logic-analyzer-info-row',
          m('b', 'Max Sample Rate: '),
          formatHz(meta.maxSampleRateHz),
        ),
        m(
          '.pf-logic-analyzer-info-row',
          m('b', 'Probes: '),
          String(meta.numProbes),
        ),
        m(
          '.pf-logic-analyzer-info-row',
          m('b', 'Sample Memory: '),
          formatBytes(meta.sampleMemoryBytes),
        ),
        meta.capabilities &&
          m(
            '.pf-logic-analyzer-info-row',
            m('b', 'Capabilities: '),
            meta.capabilities,
          ),
      ),
    );
  }

  private renderPinConfig(): m.Children {
    const maxGpio = this.s.metadata?.maxGpio ?? 54;
    return m(
      Section,
      {
        title: 'Pin Configuration',
        subtitle: 'Assign GPIO pins to logic analyzer channels',
      },
      m(
        'table.pf-logic-analyzer-pin-table',
        m(
          'thead',
          m(
            'tr',
            m('th', 'Ch'),
            m('th', 'Label'),
            m('th', 'GPIO'),
            m('th', 'Enabled'),
          ),
        ),
        m(
          'tbody',
          this.s.channels.map((ch, i) =>
            m(
              'tr',
              {className: ch.enabled ? 'enabled' : 'disabled'},
              m('td.channel-num', `D${i}`),
              m(
                'td',
                m('input.pf-logic-analyzer-label-input', {
                  type: 'text',
                  value: ch.label,
                  size: 8,
                  oninput: (e: InputEvent) => {
                    ch.label = (e.target as HTMLInputElement).value;
                  },
                }),
              ),
              m(
                'td',
                m(
                  Select,
                  {
                    value: String(ch.gpio),
                    onchange: (e: Event) => {
                      ch.gpio = Number((e.target as HTMLSelectElement).value);
                      if (ch.gpio >= 0) {
                        ch.enabled = true;
                      } else {
                        ch.enabled = false;
                      }
                      this.s.trimChannels();
                    },
                  },
                  m('option', {value: '-1'}, 'None'),
                  Array.from({length: maxGpio + 1}, (_, g) =>
                    m('option', {value: String(g)}, `GPIO ${g}`),
                  ),
                ),
              ),
              m(
                'td',
                m('input', {
                  type: 'checkbox',
                  checked: ch.enabled && ch.gpio >= 0,
                  disabled: ch.gpio < 0,
                  onchange: (e: Event) => {
                    ch.enabled = (e.target as HTMLInputElement).checked;
                  },
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  private renderCaptureSettings(): m.Children {
    const maxRate = this.s.metadata?.maxSampleRateHz ?? 1000000;
    const sampleCount = durationToSamples(
      this.s.captureDurationMs,
      this.s.sampleRateHz,
    );
    const enabledPins = this.s.channels.filter(
      (ch) => ch.enabled && ch.gpio >= 0,
    ).length;
    const bytes = samplesToBytes(sampleCount, enabledPins);
    return m(
      Section,
      {title: 'Capture Settings'},
      m(
        '.pf-logic-analyzer-row',
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Sample Rate'),
          m(
            Select,
            {
              value: String(this.s.sampleRateHz),
              onchange: (e: Event) => {
                this.s.sampleRateHz = Number(
                  (e.target as HTMLSelectElement).value,
                );
              },
            },
            generateSampleRates(maxRate).map((rate) =>
              m('option', {value: String(rate)}, formatHz(rate)),
            ),
          ),
        ),
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Duration'),
          m(
            Select,
            {
              value: String(this.s.captureDurationMs),
              onchange: (e: Event) => {
                this.s.captureDurationMs = Number(
                  (e.target as HTMLSelectElement).value,
                );
              },
            },
            CAPTURE_DURATIONS.map((d) =>
              m('option', {value: String(d.ms)}, d.label),
            ),
          ),
        ),
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Samples'),
          m('span', sampleCount.toLocaleString()),
        ),
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Bytes'),
          m(
            'span',
            {
              style: this.capturedBytesExceedMemory()
                ? 'color: var(--pf-color-danger); font-weight: bold'
                : '',
            },
            formatBytes(bytes),
            this.capturedBytesExceedMemory() &&
              ` (exceeds ${formatBytes(this.s.metadata!.sampleMemoryBytes)})`,
          ),
        ),
      ),
    );
  }

  private renderEnablePin(): m.Children {
    const maxGpio = this.s.metadata?.maxGpio ?? 54;
    return m(
      Section,
      {
        title: 'Enable Pin (Optional)',
        subtitle: 'Gate capture with an external valid/enable signal',
      },
      m(
        '.pf-logic-analyzer-row',
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Enable GPIO'),
          m(
            Select,
            {
              value: String(this.s.enableGpio),
              onchange: (e: Event) => {
                this.s.enableGpio = Number(
                  (e.target as HTMLSelectElement).value,
                );
              },
            },
            m('option', {value: '-1'}, 'Disabled'),
            Array.from({length: maxGpio + 1}, (_, g) =>
              m('option', {value: String(g)}, `GPIO ${g}`),
            ),
          ),
        ),
        m(
          '.pf-logic-analyzer-field',
          m('label', 'Active Low'),
          m('input', {
            type: 'checkbox',
            checked: this.s.enableActiveLow,
            disabled: this.s.enableGpio < 0,
            onchange: (e: Event) => {
              this.s.enableActiveLow = (e.target as HTMLInputElement).checked;
            },
          }),
        ),
      ),
    );
  }

  private renderCaptureControls(): m.Children {
    const capturing =
      this.s.captureState === 'capturing' ||
      this.s.captureState === 'configuring';
    const enabledChannels = this.s.channels.filter(
      (ch) => ch.enabled && ch.gpio >= 0,
    ).length;
    return m(
      Section,
      {title: 'Capture'},
      enabledChannels === 0 &&
        m(
          '.pf-logic-analyzer-status.error',
          'No channels enabled. Assign GPIO pins above.',
        ),
      enabledChannels > 0 &&
        this.capturedBytesExceedMemory() &&
        m(
          '.pf-logic-analyzer-status.error',
          'Capture size exceeds device sample memory. Reduce duration, sample rate, or number of channels.',
        ),
      m(
        '.pf-logic-analyzer-row',
        capturing
          ? [
              m(Spinner),
              m(
                'span',
                `Capturing... ${formatBytes(this.s.bytesReceived)} received`,
              ),
            ]
          : m(Button, {
              label: 'Start Capture',
              icon: 'play_arrow',
              variant: ButtonVariant.Filled,
              disabled:
                !this.s.transport.connected ||
                enabledChannels === 0 ||
                this.s.captureState !== 'idle' ||
                this.capturedBytesExceedMemory(),
              onclick: () => this.startCapture(),
            }),
      ),
    );
  }

  private capturedBytesExceedMemory(): boolean {
    if (!this.s.metadata) return false;
    const sampleCount = durationToSamples(
      this.s.captureDurationMs,
      this.s.sampleRateHz,
    );
    const enabledPins = this.s.channels.filter(
      (ch) => ch.enabled && ch.gpio >= 0,
    ).length;
    const bytes = samplesToBytes(sampleCount, enabledPins);
    return bytes > this.s.metadata.sampleMemoryBytes;
  }

  private async connect(): Promise<void> {
    this.s.captureState = 'connecting';
    this.s.statusMessage = '';
    m.redraw();
    try {
      await this.s.transport.connect({baudRate: this.s.baudRate});
      this.s.protocol = new SumpProtocol(this.s.transport);

      // Reset and identify the device.
      await this.s.protocol.reset();
      const id = await this.s.protocol.identify();
      if (id !== '1ALS') {
        this.s.statusMessage = `Error: unexpected device ID "${id}"`;
        await this.s.transport.disconnect();
        this.s.captureState = 'idle';
        m.redraw();
        return;
      }

      // Get device metadata.
      this.s.metadata = await this.s.protocol.getMetadata();
      this.s.sampleRateHz = Math.min(
        this.s.sampleRateHz,
        this.s.metadata.maxSampleRateHz,
      );

      this.s.statusMessage = `Connected to ${this.s.metadata.deviceName}`;
      this.s.captureState = 'idle';
    } catch (e) {
      this.s.statusMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
      this.s.captureState = 'idle';
      try {
        await this.s.transport.disconnect();
      } catch (_) {
        // Ignore.
      }
    }
    m.redraw();
  }

  private async disconnect(): Promise<void> {
    await this.s.transport.disconnect();
    this.s.protocol = undefined;
    this.s.metadata = undefined;
    this.s.captureState = 'idle';
    this.s.statusMessage = '';
    m.redraw();
  }

  private async startCapture(): Promise<void> {
    if (!this.s.protocol || !this.s.transport.connected) return;

    this.s.captureState = 'configuring';
    this.s.bytesReceived = 0;
    this.s.statusMessage = '';
    m.redraw();

    try {
      // Reset device state.
      await this.s.protocol.reset();

      // Send all channel mappings as -1 so the device uses its defaults.
      for (let i = 0; i < this.s.channels.length; i++) {
        await this.s.protocol.setPinMapping(i, -1);
      }

      // Configure enable pin.
      await this.s.protocol.setEnablePin(
        this.s.enableGpio,
        this.s.enableActiveLow,
      );

      // Set sample rate.
      const maxRate = this.s.metadata?.maxSampleRateHz ?? 1000000;
      await this.s.protocol.setSampleRate(this.s.sampleRateHz, maxRate);

      // Compute sample count from duration and set read count.
      const sampleCount = durationToSamples(
        this.s.captureDurationMs,
        this.s.sampleRateHz,
      );
      await this.s.protocol.setReadCount(sampleCount);

      // Set flags (no special flags for now).
      await this.s.protocol.setFlags(0);

      // Set output format to Perfetto protobuf.
      await this.s.protocol.setOutputFormat(OUTPUT_FORMAT_PERFETTO);

      // Start capture.
      this.s.captureState = 'capturing';
      m.redraw();

      await this.s.protocol.run();

      // Read the Perfetto trace data until the device sends an empty
      // trace packet (0x0A 0x00) signalling end-of-stream. Allow more
      // time than the capture duration for serial transfer overhead.
      const END_SENTINEL = new Uint8Array([0x0a, 0x00]);
      const timeoutMs = this.s.captureDurationMs + 30000;
      const rawData = await this.s.transport.readUntilSentinel(
        END_SENTINEL,
        timeoutMs,
        (_chunk, totalBytes) => {
          this.s.bytesReceived = totalBytes;
          m.redraw();
        },
      );

      if (rawData.length === 0) {
        this.s.statusMessage = 'Error: no trace data received';
        this.s.captureState = 'idle';
        m.redraw();
        return;
      }

      // Log raw data for debugging.
      console.log(`[LogicAnalyzer] Raw data received: ${rawData.length} bytes`);
      console.log(
        '[LogicAnalyzer] First 64 bytes (hex):',
        hexDump(rawData, 0, 64),
      );

      // Open the trace in Perfetto.
      this.s.captureState = 'loading';
      this.s.statusMessage = `Loading ${formatBytes(rawData.length)} trace...`;
      m.redraw();

      await this.app.openTraceFromBuffer({
        buffer: rawData.buffer,
        title: 'Logic Capture',
        fileName: 'logic_capture.perfetto-trace',
      });

      this.s.captureState = 'idle';
      this.s.statusMessage = '';
    } catch (e) {
      this.s.statusMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
      this.s.captureState = 'idle';
      m.redraw();
    }
  }
}

const CAPTURE_DURATIONS = [
  {ms: 1, label: '1 ms'},
  {ms: 2, label: '2 ms'},
  {ms: 5, label: '5 ms'},
  {ms: 10, label: '10 ms'},
  {ms: 20, label: '20 ms'},
  {ms: 50, label: '50 ms'},
  {ms: 100, label: '100 ms'},
  {ms: 200, label: '200 ms'},
  {ms: 500, label: '500 ms'},
  {ms: 1000, label: '1 s'},
  {ms: 2000, label: '2 s'},
  {ms: 5000, label: '5 s'},
  {ms: 10000, label: '10 s'},
];

function durationToSamples(durationMs: number, sampleRateHz: number): number {
  // Round to nearest multiple of 4 (SUMP protocol requirement).
  const raw = Math.round((durationMs / 1000) * sampleRateHz);
  return Math.max(4, Math.round(raw / 4) * 4);
}

function samplesToBytes(sampleCount: number, enabledPins: number): number {
  // 1, 2, and 4 pin captures pack multiple samples into a single byte.
  if (enabledPins <= 1) return Math.ceil(sampleCount / 8);
  if (enabledPins <= 2) return Math.ceil(sampleCount / 4);
  if (enabledPins <= 4) return Math.ceil(sampleCount / 2);
  if (enabledPins <= 8) return sampleCount;
  return sampleCount * 2;
}

function formatHz(hz: number): string {
  if (hz >= 1000000)
    {return `${(hz / 1000000).toFixed(hz % 1000000 ? 1 : 0)} MHz`;}
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz`;
  return `${hz} Hz`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function generateSampleRates(maxRate: number): number[] {
  const rates: number[] = [];
  // Generate power-of-2 divisions of max rate.
  let rate = maxRate;
  while (rate >= 100) {
    rates.push(rate);
    rate = Math.floor(rate / 2);
  }
  return rates;
}

function hexDump(data: Uint8Array, offset: number, length: number): string {
  const end = Math.min(offset + length, data.length);
  const parts: string[] = [];
  for (let i = offset; i < end; i++) {
    parts.push(data[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}
