/**
 * WebGPU capability probe.
 *
 * `navigator.gpu` and even `requestAdapter()` can succeed on machines where WebGPU is unusable
 * (e.g. headless Chromium on SwiftShader reports an adapter whose device is destroyed right away).
 * three's own fallback only triggers when the adapter is missing, and a canvas that has already
 * handed out a `webgpu` context can never produce a `webgl2` one, so we verify on a throw-away
 * OffscreenCanvas *before* the real canvas is touched.
 */

let cached: Promise<boolean> | undefined;

export function probeWebGPU(): Promise<boolean> {
  cached ??= runProbe().catch(() => false);
  return cached;
}

async function runProbe(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu || typeof OffscreenCanvas === 'undefined') return false;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return false;
  const device = await adapter.requestDevice();
  let lost = false;
  void device.lost.then(() => {
    lost = true;
  });
  try {
    const ctx = new OffscreenCanvas(4, 4).getContext(
      'webgpu',
    ) as unknown as GPUCanvasContext | null;
    if (!ctx) return false;
    ctx.configure({ device, format: gpu.getPreferredCanvasFormat() });
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      })
      .end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    // Give a destroyed/lost device a moment to report itself.
    await new Promise((r) => setTimeout(r, 30));
    return !lost;
  } catch {
    return false;
  } finally {
    if (!lost) device.destroy();
  }
}
