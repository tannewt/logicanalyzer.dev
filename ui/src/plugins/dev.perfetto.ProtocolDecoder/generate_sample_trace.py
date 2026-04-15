#!/usr/bin/env python3
# Copyright (C) 2025 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Generate a sample Perfetto trace demonstrating NeoPixel, SPI, and I2C
protocol decoder signals.

Usage:
    python generate_sample_trace.py [output_file]

Defaults to protocol_decoder_sample.pftrace in the current directory.
"""

import struct
import sys

from perfetto.protos.perfetto.trace.perfetto_trace_pb2 import Trace
from perfetto.protos.perfetto.trace.perfetto_trace_pb2 import TracePacket

NS = 1  # nanosecond
US = 1_000  # microsecond
MS = 1_000_000  # millisecond

SEQ_ID = 1

# Track UUIDs.
UUID_NEOPIXEL_DATA = 100
UUID_SPI_CLK = 200
UUID_SPI_MOSI = 201
UUID_SPI_MISO = 202
UUID_SPI_CS = 203
UUID_I2C_SCL = 300
UUID_I2C_SDA = 301


def add_track_descriptor(trace, uuid, name, parent_uuid=None):
  """Add a counter track descriptor."""
  pkt = trace.packet.add()
  pkt.trusted_packet_sequence_id = SEQ_ID
  td = pkt.track_descriptor
  td.uuid = uuid
  td.name = name
  # Mark it as a counter track.
  td.counter.SetInParent()
  if parent_uuid is not None:
    td.parent_uuid = parent_uuid


def add_counter(trace, uuid, ts_ns, value):
  """Add a counter event at a given timestamp."""
  pkt = trace.packet.add()
  pkt.timestamp = ts_ns
  pkt.trusted_packet_sequence_id = SEQ_ID
  te = pkt.track_event
  te.type = 4  # TYPE_COUNTER
  te.track_uuid = uuid
  te.counter_value = value


def add_digital_signal(trace, uuid, edges):
  """Add a sequence of (timestamp_ns, value) pairs as counter events.

    `edges` is a list of (ts_ns, 0_or_1) tuples.
    """
  for ts, val in edges:
    add_counter(trace, uuid, ts, val)


# ---------------------------------------------------------------------------
# NeoPixel / WS2812B signal generation
# ---------------------------------------------------------------------------


def ws2812b_bit(t, bit):
  """Generate edges for one WS2812B bit starting at time t.

    Returns (edges, end_time).  Edges include the leading rising edge,
    the falling edge, and a trailing low until the next bit.

    WS2812B timing (approximate):
      bit 0: high 350ns, low 900ns  (total ~1250ns)
      bit 1: high 700ns, low 600ns  (total ~1300ns)
    """
  if bit:
    t_high = 700 * NS
    t_low = 600 * NS
  else:
    t_high = 350 * NS
    t_low = 900 * NS

  edges = [
      (t, 1),  # rising edge
      (t + t_high, 0),  # falling edge
  ]
  return edges, t + t_high + t_low


def ws2812b_byte(t, value):
  """Generate edges for one byte (8 bits, MSB first)."""
  edges = []
  for i in range(7, -1, -1):
    bit = (value >> i) & 1
    bit_edges, t = ws2812b_bit(t, bit)
    edges.extend(bit_edges)
  return edges, t


def ws2812b_pixel(t, g, r, b):
  """Generate edges for one NeoPixel (GRB order)."""
  edges = []
  for byte_val in [g, r, b]:
    byte_edges, t = ws2812b_byte(t, byte_val)
    edges.extend(byte_edges)
  return edges, t


def ws2812b_reset(t):
  """Generate a reset pulse (>50us low)."""
  return [(t, 0)], t + 80 * US


def generate_neopixel(trace, base_time):
  """Generate NeoPixel data: 2 frames of 4 pixels each.

    Frame 1: Red, Green, Blue, White
    Frame 2: Yellow, Cyan, Magenta, Orange
    """
  pixels_frame1 = [
      (0x00, 0xFF, 0x00),  # Red   (GRB)
      (0xFF, 0x00, 0x00),  # Green (GRB)
      (0x00, 0x00, 0xFF),  # Blue  (GRB)
      (0xFF, 0xFF, 0xFF),  # White (GRB)
  ]
  pixels_frame2 = [
      (0x80, 0xFF, 0x00),  # Yellow  (GRB)
      (0xFF, 0x00, 0xFF),  # Cyan    (GRB)
      (0x00, 0xFF, 0xFF),  # Magenta (GRB)
      (0x33, 0xFF, 0x66),  # Orange  (GRB)
  ]

  all_edges = [(base_time, 0)]  # start low
  t = base_time + 1 * US

  for g, r, b in pixels_frame1:
    pixel_edges, t = ws2812b_pixel(t, g, r, b)
    all_edges.extend(pixel_edges)

  reset_edges, t = ws2812b_reset(t)
  all_edges.extend(reset_edges)

  for g, r, b in pixels_frame2:
    pixel_edges, t = ws2812b_pixel(t, g, r, b)
    all_edges.extend(pixel_edges)

  reset_edges, t = ws2812b_reset(t)
  all_edges.extend(reset_edges)

  add_digital_signal(trace, UUID_NEOPIXEL_DATA, all_edges)
  return t


# ---------------------------------------------------------------------------
# SPI signal generation
# ---------------------------------------------------------------------------


def generate_spi_byte(t, mosi_val, miso_val, half_period):
  """Generate CLK, MOSI, MISO edges for one SPI byte (mode 0, MSB first).

    Mode 0: CPOL=0 CPHA=0 — data set on falling edge, sampled on rising.
    We set data on the falling edge (or at start), then clock rises to sample.
    """
  clk_edges = []
  mosi_edges = []
  miso_edges = []

  for i in range(7, -1, -1):
    mosi_bit = (mosi_val >> i) & 1
    miso_bit = (miso_val >> i) & 1

    # Set data lines (before rising edge).
    mosi_edges.append((t, mosi_bit))
    miso_edges.append((t, miso_bit))

    # Rising edge (sample point).
    t += half_period
    clk_edges.append((t, 1))

    # Falling edge.
    t += half_period
    clk_edges.append((t, 0))

  return clk_edges, mosi_edges, miso_edges, t


def generate_spi(trace, base_time):
  """Generate an SPI transaction: CS low, 3 bytes, CS high.

    Sends bytes 0xA5, 0x3C, 0x7E on MOSI.
    Receives bytes 0x12, 0x34, 0x56 on MISO.
    """
  half_period = 500 * NS  # 1 MHz clock
  gap = 5 * US

  all_clk = [(base_time, 0)]
  all_mosi = [(base_time, 0)]
  all_miso = [(base_time, 0)]
  all_cs = [(base_time, 1)]  # CS idle high

  mosi_bytes = [0xA5, 0x3C, 0x7E]
  miso_bytes = [0x12, 0x34, 0x56]

  # --- Transaction 1 ---
  t = base_time + 2 * US
  all_cs.append((t, 0))  # CS active (low)
  t += 500 * NS  # small delay after CS

  for mosi_val, miso_val in zip(mosi_bytes, miso_bytes):
    clk_e, mosi_e, miso_e, t = generate_spi_byte(t, mosi_val, miso_val,
                                                 half_period)
    all_clk.extend(clk_e)
    all_mosi.extend(mosi_e)
    all_miso.extend(miso_e)
    t += 200 * NS  # inter-byte gap

  t += 500 * NS
  all_cs.append((t, 1))  # CS deassert

  # --- Transaction 2 ---
  t += gap
  all_cs.append((t, 0))  # CS active again

  mosi_bytes2 = [0xFF, 0x00]
  miso_bytes2 = [0xAB, 0xCD]
  t += 500 * NS

  for mosi_val, miso_val in zip(mosi_bytes2, miso_bytes2):
    clk_e, mosi_e, miso_e, t = generate_spi_byte(t, mosi_val, miso_val,
                                                 half_period)
    all_clk.extend(clk_e)
    all_mosi.extend(mosi_e)
    all_miso.extend(miso_e)
    t += 200 * NS

  t += 500 * NS
  all_cs.append((t, 1))  # CS deassert

  add_digital_signal(trace, UUID_SPI_CLK, all_clk)
  add_digital_signal(trace, UUID_SPI_MOSI, all_mosi)
  add_digital_signal(trace, UUID_SPI_MISO, all_miso)
  add_digital_signal(trace, UUID_SPI_CS, all_cs)
  return t


# ---------------------------------------------------------------------------
# I2C signal generation
# ---------------------------------------------------------------------------


def i2c_start(t, half_period):
  """Generate I2C START condition: SDA falls while SCL is high.

    Returns (scl_edges, sda_edges, end_time).
    Precondition: SCL=1, SDA=1 (idle).
    """
  scl = []
  sda = []
  # SDA goes low while SCL is high -> START.
  sda.append((t, 0))
  t += half_period
  # Then SCL goes low to begin clocking.
  scl.append((t, 0))
  t += half_period
  return scl, sda, t


def i2c_stop(t, half_period):
  """Generate I2C STOP condition: SDA rises while SCL is high.

    Precondition: SCL=0, SDA=0 (after last ACK clock low).
    """
  scl = []
  sda = []
  # Make sure SDA is low.
  sda.append((t, 0))
  t += half_period
  # SCL goes high.
  scl.append((t, 1))
  t += half_period
  # SDA goes high while SCL is high -> STOP.
  sda.append((t, 1))
  t += half_period
  return scl, sda, t


def i2c_bit(t, bit, half_period):
  """Clock one I2C data bit.

    Precondition: SCL=0.
    Sets SDA, raises SCL (sample point), lowers SCL.
    """
  scl = []
  sda = []

  # Set SDA while SCL is low.
  sda.append((t, bit))
  t += half_period

  # SCL rises (data sampled here).
  scl.append((t, 1))
  t += half_period

  # SCL falls.
  scl.append((t, 0))
  t += half_period

  return scl, sda, t


def i2c_byte_with_ack(t, value, ack, half_period):
  """Clock one I2C byte (MSB first) + ACK/NACK bit.

    ack=True means ACK (SDA=0 on 9th clock), False means NACK (SDA=1).
    """
  all_scl = []
  all_sda = []

  # 8 data bits, MSB first.
  for i in range(7, -1, -1):
    bit = (value >> i) & 1
    scl_e, sda_e, t = i2c_bit(t, bit, half_period)
    all_scl.extend(scl_e)
    all_sda.extend(sda_e)

  # ACK/NACK bit (receiver drives SDA).
  ack_bit = 0 if ack else 1
  scl_e, sda_e, t = i2c_bit(t, ack_bit, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  return all_scl, all_sda, t


def generate_i2c(trace, base_time):
  """Generate I2C transactions:

    Transaction 1: Write to address 0x50, data bytes 0xAB, 0xCD (all ACK).
    Transaction 2: Read from address 0x68, data bytes 0x12, 0x34 (ACK, NACK).
    """
  half_period = 1 * US  # ~250 kHz (half of 500 kHz period)
  gap = 10 * US

  all_scl = [(base_time, 1)]  # idle high
  all_sda = [(base_time, 1)]  # idle high
  t = base_time + 5 * US

  # --- Transaction 1: Write 0x50, data 0xAB 0xCD ---
  scl_e, sda_e, t = i2c_start(t, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  # Address byte: 0x50 << 1 | 0 (write) = 0xA0.
  scl_e, sda_e, t = i2c_byte_with_ack(t, 0xA0, True, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  # Data byte 0xAB.
  scl_e, sda_e, t = i2c_byte_with_ack(t, 0xAB, True, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  # Data byte 0xCD.
  scl_e, sda_e, t = i2c_byte_with_ack(t, 0xCD, True, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  scl_e, sda_e, t = i2c_stop(t, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  t += gap

  # --- Transaction 2: Read 0x68, data 0x12 0x34 ---
  scl_e, sda_e, t = i2c_start(t, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  # Address byte: 0x68 << 1 | 1 (read) = 0xD1.
  scl_e, sda_e, t = i2c_byte_with_ack(t, 0xD1, True, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  # Data byte 0x12, ACK (more to read).
  scl_e, sda_e, t = i2c_byte_with_ack(t, 0x12, True, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  # Data byte 0x34, NACK (last byte).
  scl_e, sda_e, t = i2c_byte_with_ack(t, 0x34, False, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  scl_e, sda_e, t = i2c_stop(t, half_period)
  all_scl.extend(scl_e)
  all_sda.extend(sda_e)

  add_digital_signal(trace, UUID_I2C_SCL, all_scl)
  add_digital_signal(trace, UUID_I2C_SDA, all_sda)
  return t


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
  output_file = sys.argv[1] if len(sys.argv) > 1 else \
      'protocol_decoder_sample.pftrace'

  trace = Trace()

  # Sequence state reset packet (required for track event parsing).
  pkt = trace.packet.add()
  pkt.trusted_packet_sequence_id = SEQ_ID
  pkt.sequence_flags = 1  # SEQ_INCREMENTAL_STATE_CLEARED

  # -- Track descriptors --
  add_track_descriptor(trace, UUID_NEOPIXEL_DATA, 'NeoPixel Data')

  add_track_descriptor(trace, UUID_SPI_CLK, 'SPI CLK')
  add_track_descriptor(trace, UUID_SPI_MOSI, 'SPI MOSI')
  add_track_descriptor(trace, UUID_SPI_MISO, 'SPI MISO')
  add_track_descriptor(trace, UUID_SPI_CS, 'SPI CS')

  add_track_descriptor(trace, UUID_I2C_SCL, 'I2C SCL')
  add_track_descriptor(trace, UUID_I2C_SDA, 'I2C SDA')

  # -- Signal data --
  # Spread protocols across time so they don't overlap.
  t = 0
  t = generate_neopixel(trace, t)
  t += 100 * US
  t = generate_spi(trace, t)
  t += 100 * US
  t = generate_i2c(trace, t)

  # Write the trace.
  with open(output_file, 'wb') as f:
    f.write(trace.SerializeToString())

  print(f'Wrote {output_file} ({len(trace.packet)} packets)')


if __name__ == '__main__':
  main()
