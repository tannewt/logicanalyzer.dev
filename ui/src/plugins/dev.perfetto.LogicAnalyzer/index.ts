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
import {PerfettoPlugin} from '../../public/plugin';
import {LogicAnalyzerPage, LogicAnalyzerState} from './logic_analyzer_page';

export default class implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.LogicAnalyzer';
  static readonly description =
    'Logic analyzer capture and analysis via WebSerial (SUMP protocol)';

  private static state?: LogicAnalyzerState;

  static onActivate(app: App): void {
    app.sidebar.addMenuItem({
      section: 'trace_files',
      text: 'Logic analyzer',
      href: '#!/logic',
      icon: 'timeline',
      sortOrder: 3,
    });
    app.pages.registerPage({
      route: '/logic',
      render: () => {
        if (!this.state) {
          this.state = new LogicAnalyzerState();
        }
        return m(LogicAnalyzerPage, {app, state: this.state});
      },
    });
  }
}
