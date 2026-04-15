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

import {AppImpl} from '../../core/app_impl';
import {App} from '../../public/app';
import {PerfettoPlugin} from '../../public/plugin';

const TRACE_PATH = '/test/data/protocol_decoder_sample.pftrace';

export default class implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.ProtocolDecoderExample';
  static onActivate(ctx: App) {
    const cmdId = 'dev.perfetto.OpenExampleProtocolDecoderTrace';
    ctx.commands.registerCommand({
      id: cmdId,
      name: 'Open Protocol Decoder example',
      callback: () => {
        ctx.analytics.logEvent('Trace Actions', 'Open example trace');
        const url = `${window.location.origin}${TRACE_PATH}`;
        fetch(url)
          .then((resp) => resp.blob())
          .then((blob) => {
            const file = new File([blob], 'protocol_decoder_sample.pftrace');
            AppImpl.instance.openTraceFromFile(file);
          })
          .catch((e) => alert(`Could not load sample trace: ${e}`));
      },
    });
    ctx.sidebar.addMenuItem({
      section: 'trace_files',
      commandId: cmdId,
      icon: 'memory',
      sortOrder: 5,
    });
  }
}
