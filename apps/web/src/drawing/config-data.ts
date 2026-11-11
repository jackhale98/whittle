/**
 * What a drawing reads from the model, per configuration: the regen result (meshes, annotation
 * resolutions), its shape for the drawing kernel, and the resolved document the values come from.
 *
 * The active configuration reads the live regen, and only when it is current for the document: a
 * regen that predates the last model edit is "pending", never shown as if it were fresh (trap T1).
 * Any other configuration regenerates in its own `config:<id>` slot, as the configuration builds do
 * (ADR-074), memoised by what the regen reads.
 */

import type {
  AnnotationResolution,
  Id,
  RegenResult,
  RegenSlot,
  Result,
  ShapeForDrawing,
  WrenDoc,
} from '@wren-cad/contracts';
import type { Workbench } from '../app/workbench';
import { host } from './host';

export interface ConfigData {
  configId: Id | null;
  /** The configuration's resolved document (what the regen read). */
  doc: WrenDoc;
  result: RegenResult;
  resolutions: ReadonlyMap<Id, AnnotationResolution>;
  shape: ShapeForDrawing;
  /** Part mass in kg, or `'building'` while it is computed, or undefined without a material. */
  mass?: number | 'building';
}

export type ConfigLookup =
  | { ok: true; data: ConfigData }
  | { ok: false; reason: 'pending' | 'missing' | 'error'; message?: string };

/** What the regen reads, ignoring the drawings: the freshness key of a result. */
export function modelKey(doc: WrenDoc): string {
  return host.valueKey({ ...doc, drawings: [] });
}

/** `ModelingApi.shapeForDrawing`: the final BREP of the part's latest regen in a slot. */
export type ShapeFor = (partId: Id, slot: RegenSlot) => Promise<Result<ShapeForDrawing>>;

export class ConfigDataSource {
  private readonly byResult = new WeakMap<RegenResult, Promise<ConfigData>>();
  private readonly others = new Map<string, ConfigData>();

  constructor(
    private readonly wb: Workbench,
    private readonly shapeFor: ShapeFor,
  ) {}

  /** Forget the other configurations' regens (a new document). */
  reset(): void {
    this.others.clear();
  }

  async get(configId: Id | null): Promise<ConfigLookup> {
    const { wb } = this;
    const doc = wb.doc;
    const part = doc.parts[0];
    if (!part) return { ok: false, reason: 'missing', message: 'The part is gone' };
    if (configId !== null && !(part.configurations ?? []).some((c) => c.id === configId))
      return { ok: false, reason: 'missing', message: 'That configuration no longer exists' };

    if (configId === host.activeIdOf(part)) {
      const view = wb.regen.get();
      if (view?.source !== 'live') return { ok: false, reason: 'pending' };
      // Only the model matters: moving a view on the sheet does not make the regen stale.
      if (modelKey(view.doc) !== modelKey(wb.viewDoc())) return { ok: false, reason: 'pending' };
      let pending = this.byResult.get(view.result);
      if (!pending) {
        pending = this.make(part.id, 'main', configId, view.doc, view.result);
        this.byResult.set(view.result, pending);
      }
      try {
        const data = await pending;
        // Mass arrives later than geometry: refresh the figure without rebuilding the shape.
        const mass = massOf(view.result, view.doc);
        return { ok: true, data: mass === data.mass ? data : { ...data, ...withMass(mass) } };
      } catch (e) {
        this.byResult.delete(view.result);
        return { ok: false, reason: 'error', message: messageOf(e) };
      }
    }

    const resolved = host.resolveConfiguration(doc, part.id, configId).doc;
    const key = `${host.keyOf(configId)}|${modelKey(resolved)}`;
    const hit = this.others.get(key);
    if (hit) return { ok: true, data: hit };
    const modeling = wb.modeling;
    if (!modeling || !wb.loop) return { ok: false, reason: 'pending' };
    try {
      await wb.loop.whenIdle();
      const attachments = Object.fromEntries(
        wb.attachmentsFor(resolved).map((a) => [a.path, a.bytes] as const),
      );
      const result = await modeling.port.regenerate({
        doc: resolved,
        partId: part.id,
        quality: 'coarse',
        massProperties: true,
        annotations: true,
        slot: host.slotOf(configId),
        ...(Object.keys(attachments).length ? { attachments } : {}),
      });
      const slot = host.slotOf(configId);
      let data: ConfigData;
      try {
        data = await this.make(part.id, slot, configId, resolved, result);
      } finally {
        void modeling.port.closePart(part.id, slot).catch(() => {});
      }
      this.others.set(key, data);
      for (const k of [...this.others.keys()].slice(0, Math.max(0, this.others.size - 6)))
        this.others.delete(k);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, reason: 'error', message: messageOf(e) };
    }
  }

  private async make(
    partId: Id,
    slot: RegenSlot,
    configId: Id | null,
    doc: WrenDoc,
    result: RegenResult,
  ): Promise<ConfigData> {
    const shape = await this.shapeFor(partId, slot);
    if (!shape.ok) throw new Error(shape.error.message);
    return {
      configId,
      doc,
      result,
      resolutions: new Map((result.annotations ?? []).map((r) => [r.annotationId, r])),
      shape: shape.value,
      ...withMass(massOf(result, doc)),
    };
  }
}

function massOf(result: RegenResult, doc: WrenDoc): number | 'building' | undefined {
  const m = host.summarizeMass(result.bodies)?.mass;
  if (m !== undefined) return m;
  return doc.parts[0]?.material !== undefined && result.bodies.length > 0 ? 'building' : undefined;
}

const withMass = (m: number | 'building' | undefined): { mass?: number | 'building' } =>
  m === undefined ? {} : { mass: m };

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : 'The configuration could not be built';
