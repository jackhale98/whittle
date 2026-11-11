// Embind registrations for the Wren drawing kernel (wren_drawing.h). Only these functions are
// visible to JS; no OCCT class is bound, so the linker keeps only the OCCT code they reach.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// JS surface (typed in src/drawing/facade.ts):
//   drawingInfo(): string
//   loadShape(path: string): string
//   project(shape: number, requestJson: string): string
//   configureThreads(count: number): string
//   release(shape: number): void
//   liveHandleCount(): number

#include "wren_drawing.h"

#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(wren_drawing) {
  emscripten::function("drawingInfo", &whittle::drawingInfo);
  emscripten::function("loadShape", &whittle::loadShape);
  emscripten::function("project", &whittle::project);
  emscripten::function("configureThreads", &whittle::configureThreads);
  emscripten::function("release", &whittle::release);
  emscripten::function("liveHandleCount", &whittle::liveHandleCount);
}
