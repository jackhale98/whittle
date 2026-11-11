// SPDX-License-Identifier: GPL-3.0-or-later
// The drawing support is a lazily loaded chunk in the app; the suite registers it up front.
import { registerDrawingSupport } from '../src/drawing';

registerDrawingSupport();
