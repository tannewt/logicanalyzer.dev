// Copyright (C) 2024 The Android Open Source Project
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

// Plugins in this list will run by default when users boot up the UI.
// Users may choose to enable plugins which are not in this list, but they will
// need to do this manually.
// In order to get a plugin into this list it must:
// - Use only the available plugin API (no hacks).
// - Follow naming conventions for tracks and plugins.
// - Not directly rely on any other plugins.
// - Be approved by one of Perfetto UI owners.
export const defaultPlugins = [
  'dev.perfetto.AggregateProfiles',
  'dev.perfetto.AutoPinAndExpandTracks',
  'dev.perfetto.BookmarkletApi',
  'dev.perfetto.CoreCommands',
  'dev.perfetto.CpuFreq',
  'dev.perfetto.CpuProfile',
  'dev.perfetto.CpuidleTimeInState',
  'dev.perfetto.CriticalPath',
  'dev.perfetto.DebugTracks',
  'dev.perfetto.DeeplinkQuerystring',
  'dev.perfetto.EntityStateResidency',
  'dev.perfetto.FlagsPage',
  'dev.perfetto.FlowEventsPanel',
  'dev.perfetto.Frames',
  'dev.perfetto.Ftrace',
  'dev.perfetto.GlobalGroups',
  'dev.perfetto.GpuFreq',
  'dev.perfetto.HeapProfile',
  'dev.perfetto.InstrumentsSamplesProfile',
  'dev.perfetto.KernelTrackEvent',
  'dev.perfetto.LinuxPerf',
  'dev.perfetto.LogicAnalyzer',
  'dev.perfetto.Notes',
  'dev.perfetto.PowerRails',
  'dev.perfetto.Process',
  'dev.perfetto.ProcessSummary',
  'dev.perfetto.ProcessThreadGroups',
  'dev.perfetto.ProtocolDecoder',
  'dev.perfetto.ProtocolDecoderExample',
  'dev.perfetto.QueryLog',
  'dev.perfetto.Sched',
  'dev.perfetto.Screenshots',
  'dev.perfetto.SettingsPage',
  'dev.perfetto.SqlModules',
  'dev.perfetto.StandardGroups',
  'dev.perfetto.Thread',
  'dev.perfetto.TimelineSync',
  'dev.perfetto.TraceInfoPage',
  'dev.perfetto.TraceMetadata',
  'dev.perfetto.TraceProcessorTrack',
  'dev.perfetto.TrackEvent',
  'dev.perfetto.TrackUtils',
  'org.kernel.LinuxKernelSubsystems',
  'org.kernel.SuspendResumeLatency',
  'org.kernel.Wattson',
];
