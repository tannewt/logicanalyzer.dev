// Copyright (C) 2018 The Android Open Source Project
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
import {Anchor} from '../widgets/anchor';
import {HotkeyGlyphs} from '../widgets/hotkey_glyphs';
import {Stack} from '../widgets/stack';
import {Switch} from '../widgets/switch';
import {AppImpl} from '../core/app_impl';

export class Hints implements m.ClassComponent {
  view() {
    const themeSetting = AppImpl.instance.settings.get<string>('theme');
    const isDarkMode = themeSetting?.get() === 'dark';

    return m(
      '.pf-home-page__hints',
      m(
        'ul',
        m(
          'li',
          'This is a fork of ',
          m(
            Anchor,
            {
              href: 'https://ui.perfetto.dev',
            },
            'Perfetto',
          ),
          '.',
        ),
        m(
          'li',
          'New file formats:',
          m(
            'ul',
            m('li', 'Saleae binary export.'),
            m('li', 'Saleae CSV export (I2C decoder output).'),
          ),
        ),
        m('li', [
          m(Switch, {
            label: ['Try the new dark mode.', isDarkMode && ' \u{1F60E}'],
            checked: isDarkMode,
            onchange: (e) => {
              themeSetting?.set(
                (e.target as HTMLInputElement).checked ? 'dark' : 'light',
              );
            },
          }),
        ]),
        m(
          'li',
          'Press ',
          m(HotkeyGlyphs, {hotkey: 'Mod+P'}),
          ' to quickly find tracks with fuzzy search.',
        ),
        m(
          'li',
          'Click or drag to navigate the trace ( ',
          m(
            Stack,
            {inline: true, spacing: 'small', orientation: 'horizontal'},
            [
              m(HotkeyGlyphs, {hotkey: 'W'}),
              m(HotkeyGlyphs, {hotkey: 'A'}),
              m(HotkeyGlyphs, {hotkey: 'S'}),
              m(HotkeyGlyphs, {hotkey: 'D'}),
            ],
          ),
          ' still works too).',
        ),
        m(
          'li',
          'Try the ',
          m(
            Anchor,
            {
              href: 'https://perfetto.dev/docs/visualization/perfetto-ui#command-palette',
            },
            'command palette,',
          ),
          ' press ',
          m(HotkeyGlyphs, {hotkey: '!Mod+Shift+P'}),
          '.',
        ),
      ),
    );
  }
}

export class HomePage implements m.ClassComponent {
  view() {
    return m(
      '.pf-home-page',
      m(
        '.pf-home-page__center',
        m('.pf-home-page__title', 'logicanalyzer.dev'),
        m(Hints),
      ),
    );
  }
}
