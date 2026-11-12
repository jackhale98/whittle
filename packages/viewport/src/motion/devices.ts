/**
 * 3D mouse (6-DoF controller) device ids as plain data (ADR-096). Vendor and product names appear
 * only in `compat` strings, which state compatibility; `name` is generic ("3D mouse").
 *
 * The WebHID chooser is filtered by usage page 0x01 / usage 0x08 (multi-axis controller), so a
 * device that is missing from this table still pairs and works (default layout, 350 counts); the
 * table only supplies a friendlier name, the full-scale count and the expected report layout.
 */

/** HID usage page "generic desktop" and usage "multi-axis controller". */
export const MOTION_USAGE_PAGE = 0x01;
export const MOTION_USAGE = 0x08;

/** Vendor ids of the 3Dconnexion family (the older ones ship under the Logitech id). */
export const MOTION_VENDOR_IDS: readonly number[] = [0x046d, 0x256f];

export const DEFAULT_FULL_SCALE = 350;

export interface MotionDeviceInfo {
  vendorId: number;
  productId: number;
  /** Generic name, e.g. "3D mouse (compact)". */
  name: string;
  /** Compatibility statement: the vendor's product name, for "works with" text only. */
  compat: string;
  /**
   * Report layout the model is known to use: `separate` = translation (id 1) and rotation (id 2)
   * as two 6-byte reports; `combined` = one 12-byte id-1 report. The parser decides by report
   * length either way, so this is informative (diagnostics) and never gates parsing.
   */
  layout: 'separate' | 'combined';
  /** Raw counts at full deflection (about 350 for the whole family). */
  fullScale: number;
}

const m = (
  vendorId: number,
  productId: number,
  name: string,
  compat: string,
  layout: MotionDeviceInfo['layout'] = 'separate',
  fullScale = DEFAULT_FULL_SCALE,
): MotionDeviceInfo => ({ vendorId, productId, name, compat, layout, fullScale });

export const MOTION_DEVICES: readonly MotionDeviceInfo[] = [
  // Older models under the Logitech vendor id.
  m(0x046d, 0xc603, '3D mouse (classic)', '3Dconnexion SpaceMouse Plus'),
  m(0x046d, 0xc605, '3D mouse (classic)', '3Dconnexion CADman'),
  m(0x046d, 0xc606, '3D mouse (classic)', '3Dconnexion SpaceMouse Classic'),
  m(0x046d, 0xc621, '3D mouse (ball)', '3Dconnexion SpaceBall 5000'),
  m(0x046d, 0xc623, '3D mouse (entry)', '3Dconnexion SpaceTraveler'),
  m(0x046d, 0xc625, '3D mouse (with keys)', '3Dconnexion SpacePilot'),
  m(0x046d, 0xc626, '3D mouse (entry)', '3Dconnexion SpaceNavigator'),
  m(0x046d, 0xc627, '3D mouse (with keys)', '3Dconnexion SpaceExplorer'),
  m(0x046d, 0xc628, '3D mouse (entry)', '3Dconnexion SpaceNavigator for Notebooks'),
  m(0x046d, 0xc629, '3D mouse (with keys)', '3Dconnexion SpacePilot Pro'),
  m(0x046d, 0xc62b, '3D mouse (with keys)', '3Dconnexion SpaceMouse Pro'),
  // Models under the 3Dconnexion vendor id.
  m(0x256f, 0xc62e, '3D mouse (wireless, cabled)', '3Dconnexion SpaceMouse Wireless', 'combined'),
  m(0x256f, 0xc62f, '3D mouse (wireless receiver)', '3Dconnexion SpaceMouse Wireless', 'combined'),
  m(0x256f, 0xc631, '3D mouse (pro, cabled)', '3Dconnexion SpaceMouse Pro Wireless', 'combined'),
  m(0x256f, 0xc632, '3D mouse (pro receiver)', '3Dconnexion SpaceMouse Pro Wireless', 'combined'),
  m(0x256f, 0xc633, '3D mouse (enterprise)', '3Dconnexion SpaceMouse Enterprise', 'combined'),
  m(0x256f, 0xc635, '3D mouse (compact)', '3Dconnexion SpaceMouse Compact', 'combined'),
  m(0x256f, 0xc636, '3D mouse (module)', '3Dconnexion SpaceMouse Module', 'combined'),
  m(0x256f, 0xc652, '3D mouse (universal receiver)', '3Dconnexion Universal Receiver', 'combined'),
];

export function findMotionDevice(
  vendorId: number,
  productId: number,
): MotionDeviceInfo | undefined {
  return MOTION_DEVICES.find((d) => d.vendorId === vendorId && d.productId === productId);
}

/** The `requestDevice` filters (OR-ed by the browser). */
export function motionDeviceFilters(): Array<{
  vendorId?: number;
  usagePage: number;
  usage: number;
}> {
  return [
    { usagePage: MOTION_USAGE_PAGE, usage: MOTION_USAGE },
    ...MOTION_VENDOR_IDS.map((vendorId) => ({
      vendorId,
      usagePage: MOTION_USAGE_PAGE,
      usage: MOTION_USAGE,
    })),
  ];
}
