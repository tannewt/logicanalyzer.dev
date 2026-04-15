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
import m from 'mithril';
import {Time, time} from '../../base/time';
import {TimeScale} from '../../base/time_scale';
import {Trace} from '../../public/trace';
import {
  TrackMouseEvent,
  TrackRenderContext,
  TrackRenderer,
} from '../../public/track';
import {DecodedEvent} from './decoder';
import {NeoPixelColor} from './neopixel_decoder';
import {ResetData} from './pulse_width_decoder';

const CIRCLE_RADIUS = 12;
const ROW_HEIGHT = CIRCLE_RADIUS * 2 + 4;

// Compute the maximum number of pixels between any two resets.
function computeMaxPixelCount(events: DecodedEvent[]): number {
  let max = 0;
  let current = 0;
  for (const event of events) {
    if ((event.data as ResetData).reset) {
      max = Math.max(max, current);
      current = 0;
    } else {
      current++;
    }
  }
  return Math.max(max, current, 1);
}

// Custom track renderer that draws NeoPixel colors as filled circles
// at the end of each color event, stacked vertically by pixel index.
export class NeoPixelTrackRenderer implements TrackRenderer {
  // Events sorted by timestamp for binary search.
  private readonly colorEvents: DecodedEvent[];
  // Precomputed end timestamps for positioning circles at event end.
  private readonly endTimestamps: bigint[];
  // Maximum pixels in a single frame, determines track height.
  private readonly maxPixelCount: number;

  private readonly trace: Trace;

  // Mouse position for hit-testing during render.
  private mouseX = -1;
  private mouseY = -1;
  private mouseOver = false;
  private hoveredEvent?: DecodedEvent;

  constructor(trace: Trace, events: DecodedEvent[]) {
    this.trace = trace;
    this.maxPixelCount = computeMaxPixelCount(events);
    // Filter out reset events — we only render color events.
    this.colorEvents = events.filter((e) => !(e.data as ResetData).reset);
    this.endTimestamps = this.colorEvents.map((e) => e.ts + e.dur);
  }

  getHeight(): number {
    return this.maxPixelCount * ROW_HEIGHT;
  }

  // Y center for a given pixel index.
  private centerYForPixel(pixelIndex: number): number {
    return pixelIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  }

  render({ctx, timescale, visibleWindow}: TrackRenderContext): void {
    const startTime = visibleWindow.start.toTime('floor');
    const endTime = visibleWindow.end.toTime('ceil');

    // Find the range of events visible in the current window.
    // An event is visible if its end timestamp falls within the window.
    const startIdx = Math.max(0, search(this.endTimestamps, startTime));
    let endIdx = search(this.endTimestamps, endTime);
    if (endIdx < 0) return;
    endIdx = Math.min(endIdx + 1, this.colorEvents.length - 1);

    if (this.colorEvents.length === 0) return;

    // Hit-test during render using the render's timescale so that
    // circle positions and mouse coordinates are in the same space.
    const renderHovered = this.findCircleAt(
      this.mouseX,
      this.mouseY,
      startIdx,
      endIdx,
      timescale,
    );

    for (let i = startIdx; i <= endIdx; i++) {
      const event = this.colorEvents[i];
      const color = event.data as NeoPixelColor;
      const centerY = this.centerYForPixel(color.pixelIndex);

      // Draw circle at the end of the event.
      const x = timescale.timeToPx(Time.fromRaw(event.ts + event.dur));

      // Draw filled circle with the pixel's color.
      ctx.beginPath();
      ctx.arc(x, centerY, CIRCLE_RADIUS, 0, 2 * Math.PI);
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fill();

      // Draw border for visibility (especially for dark/black colors).
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Show hex value on hovered circle.
      if (event === renderHovered) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.font = '9px Roboto Condensed, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(event.label, x, centerY + CIRCLE_RADIUS + 10);
      } else {
        // Draw pixel index label below the circle if there's room.
        const eventStartX = timescale.timeToPx(Time.fromRaw(event.ts));
        const eventWidth = x - eventStartX;
        if (eventWidth > 20) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
          ctx.font = '9px Roboto Condensed, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`#${color.pixelIndex}`, x, centerY + CIRCLE_RADIUS + 10);
        }
      }
    }
  }

  onMouseMove({x, y, timescale}: TrackMouseEvent): void {
    this.mouseX = x;
    this.mouseY = y;
    this.mouseOver = true;
    const prev = this.hoveredEvent;
    this.hoveredEvent = this.findCircleAt(
      x,
      y,
      0,
      this.colorEvents.length - 1,
      timescale,
    );
    if (prev !== this.hoveredEvent) {
      this.trace.raf.scheduleFullRedraw();
    }
  }

  onMouseOut(): void {
    this.mouseOver = false;
    const prev = this.hoveredEvent;
    this.hoveredEvent = undefined;
    if (prev !== undefined) {
      this.trace.raf.scheduleFullRedraw();
    }
  }

  renderTooltip(): m.Children {
    if (!this.hoveredEvent) return undefined;

    const color = this.hoveredEvent.data as NeoPixelColor;
    if (!color.r && color.r !== 0) return undefined;

    const hex = this.hoveredEvent.label;
    return m(
      'div',
      {style: {display: 'flex', alignItems: 'center', gap: '8px'}},
      [
        m('div', {
          style: {
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: `rgb(${color.r}, ${color.g}, ${color.b})`,
            border: '1px solid rgba(0,0,0,0.3)',
          },
        }),
        m(
          'span',
          `Pixel ${color.pixelIndex}: ${hex} ` +
            `(R:${color.r} G:${color.g} B:${color.b})`,
        ),
      ],
    );
  }

  // Find the topmost circle under the mouse cursor. Iterates in reverse
  // draw order so later (on-top) circles are preferred.
  private findCircleAt(
    mouseX: number,
    mouseY: number,
    startIdx: number,
    endIdx: number,
    timescale: TimeScale,
  ): DecodedEvent | undefined {
    if (!this.mouseOver) return undefined;

    for (let i = endIdx; i >= startIdx; i--) {
      const event = this.colorEvents[i];
      const color = event.data as NeoPixelColor;
      const centerY = this.centerYForPixel(color.pixelIndex);
      const cx = timescale.timeToPx(Time.fromRaw(event.ts + event.dur));
      const dx = mouseX - cx;
      const dy = mouseY - centerY;
      if (dx * dx + dy * dy <= CIRCLE_RADIUS * CIRCLE_RADIUS) {
        return event;
      }
    }
    return undefined;
  }
}

const HEX_TRACK_HEIGHT = 24;

// Track renderer that shows hex color values as labeled rectangles.
export class NeoPixelHexTrackRenderer implements TrackRenderer {
  private readonly trace: Trace;
  private readonly colorEvents: DecodedEvent[];
  private readonly timestamps: bigint[];

  private hoveredEvent?: DecodedEvent;

  constructor(trace: Trace, events: DecodedEvent[]) {
    this.trace = trace;
    this.colorEvents = events.filter((e) => !(e.data as ResetData).reset);
    this.timestamps = this.colorEvents.map((e) => e.ts);
  }

  getHeight(): number {
    return HEX_TRACK_HEIGHT;
  }

  render({ctx, size, timescale, visibleWindow}: TrackRenderContext): void {
    const startTime = visibleWindow.start.toTime('floor');
    const endTime = visibleWindow.end.toTime('ceil');

    const startIdx = Math.max(0, search(this.timestamps, startTime));
    let endIdx = search(this.timestamps, endTime);
    if (endIdx < 0) return;
    endIdx = Math.min(endIdx + 1, this.colorEvents.length - 1);

    ctx.font = '10px Roboto Condensed, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = startIdx; i <= endIdx; i++) {
      const event = this.colorEvents[i];
      const color = event.data as NeoPixelColor;
      const x1 = timescale.timeToPx(Time.fromRaw(event.ts));
      const x2 = timescale.timeToPx(Time.fromRaw(event.ts + event.dur));
      const w = Math.max(x2 - x1, 1);

      // Fill with a light tint of the pixel's color.
      ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.3)`;
      ctx.fillRect(x1, 2, w, size.height - 4);

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      ctx.strokeRect(x1, 2, w, size.height - 4);

      if (w > 30) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillText(event.label, x1 + w / 2, size.height / 2);
      }
    }
  }

  onMouseMove({x, timescale}: TrackMouseEvent): void {
    const hoverTime = timescale.pxToHpTime(x).toTime('floor');
    const prev = this.hoveredEvent;
    this.hoveredEvent = this.findEventAt(hoverTime);
    if (prev !== this.hoveredEvent) {
      this.trace.raf.scheduleFullRedraw();
    }
  }

  onMouseOut(): void {
    const prev = this.hoveredEvent;
    this.hoveredEvent = undefined;
    if (prev !== undefined) {
      this.trace.raf.scheduleFullRedraw();
    }
  }

  renderTooltip(): m.Children {
    if (!this.hoveredEvent) return undefined;

    const color = this.hoveredEvent.data as NeoPixelColor;
    if (!color.r && color.r !== 0) return undefined;

    const hex = this.hoveredEvent.label;
    return m(
      'div',
      {style: {display: 'flex', alignItems: 'center', gap: '8px'}},
      [
        m('div', {
          style: {
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: `rgb(${color.r}, ${color.g}, ${color.b})`,
            border: '1px solid rgba(0,0,0,0.3)',
          },
        }),
        m(
          'span',
          `Pixel ${color.pixelIndex}: ${hex} ` +
            `(R:${color.r} G:${color.g} B:${color.b})`,
        ),
      ],
    );
  }

  private findEventAt(t: time): DecodedEvent | undefined {
    const idx = search(this.timestamps, t);
    if (idx < 0 || idx >= this.colorEvents.length) return undefined;
    const event = this.colorEvents[idx];
    if (
      t >= Time.fromRaw(event.ts) &&
      t <= Time.fromRaw(event.ts + event.dur)
    ) {
      return event;
    }
    return undefined;
  }
}
