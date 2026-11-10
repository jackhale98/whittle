// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Part configuration edits for the M3.7 merge tests. The document commands for configurations are
 * being built in parallel (ADR-074), so these edit a copy of the document directly, the way those
 * commands are specified: sparse overrides (no empty records), removing a feature or parameter
 * drops its overrides, removing the active configuration makes Default active.
 */

import type { Configuration, Material, Part, WrenDoc } from '@wren-cad/contracts';
import { tidyConfiguration } from '../../src/merge/configurations';
import { apply, FILLET, id, P_WIDTH, PART } from './fixtures';

export const LONG = id(80);
export const SHORT = id(81);
export const P_SPARE = id(13);

export const STEEL: Material = {
  libraryId: 'whittle:steel-1018',
  name: 'Steel',
  density: '7.87 g/cm^3',
};
export const BRASS: Material = {
  libraryId: 'whittle:brass-c360',
  name: 'Brass',
  density: '8.5 g/cm^3',
};

export const partOf = (doc: WrenDoc, pid = PART): Part =>
  doc.parts.find((p) => p.id === pid) as Part;

export const configsOf = (doc: WrenDoc, pid = PART): Configuration[] =>
  partOf(doc, pid).configurations ?? [];

export const configOf = (doc: WrenDoc, cid: string, pid = PART): Configuration | undefined =>
  configsOf(doc, pid).find((c) => c.id === cid);

/** A copy of `doc` with `edit` applied to the part; override records are tidied afterwards. */
export function editPart(doc: WrenDoc, edit: (part: Part, doc: WrenDoc) => void): WrenDoc {
  const next = structuredClone(doc);
  const part = partOf(next);
  edit(part, next);
  for (const c of part.configurations ?? []) tidyConfiguration(c);
  if (part.configurations?.length === 0) delete part.configurations;
  return next;
}

/** A copy of `doc` with `edit` applied to one configuration. */
export function editConfig(doc: WrenDoc, cid: string, edit: (c: Configuration) => void): WrenDoc {
  return editPart(doc, (part) => {
    const c = part.configurations?.find((x) => x.id === cid);
    if (!c) throw new Error(`no configuration ${cid}`);
    edit(c);
  });
}

export const setParam = (doc: WrenDoc, cid: string, pid: string, expr: string | undefined) =>
  editConfig(doc, cid, (c) => {
    c.params ??= {};
    if (expr === undefined) delete c.params[pid];
    else c.params[pid] = expr;
  });

export const setSuppressed = (doc: WrenDoc, cid: string, fid: string, v: boolean | undefined) =>
  editConfig(doc, cid, (c) => {
    c.features ??= {};
    const o = (c.features[fid] ??= {});
    if (v === undefined) delete o.suppressed;
    else o.suppressed = v;
  });

export const setField = (
  doc: WrenDoc,
  cid: string,
  fid: string,
  pointer: string,
  v: string | number | boolean | undefined,
) =>
  editConfig(doc, cid, (c) => {
    c.features ??= {};
    const o = (c.features[fid] ??= {});
    o.fields ??= {};
    if (v === undefined) delete o.fields[pointer];
    else o.fields[pointer] = v;
  });

export const setMaterial = (doc: WrenDoc, cid: string, m: Material | null | undefined) =>
  editConfig(doc, cid, (c) => {
    if (m === undefined) delete c.material;
    else c.material = structuredClone(m);
  });

export const rename = (doc: WrenDoc, cid: string, name: string) =>
  editConfig(doc, cid, (c) => {
    c.name = name;
  });

export const addConfig = (doc: WrenDoc, c: Configuration) =>
  editPart(doc, (part) => {
    part.configurations = [...(part.configurations ?? []), structuredClone(c)];
  });

export const removeConfig = (doc: WrenDoc, cid: string) =>
  editPart(doc, (part) => {
    part.configurations = (part.configurations ?? []).filter((c) => c.id !== cid);
    if (part.activeConfigurationId === cid) delete part.activeConfigurationId;
  });

export const setActive = (doc: WrenDoc, cid: string | undefined) =>
  editPart(doc, (part) => {
    if (cid === undefined) delete part.activeConfigurationId;
    else part.activeConfigurationId = cid;
  });

/** Removes a feature with the document command, then its overrides (as M3.7's command will). */
export function removeFeature(doc: WrenDoc, fid: string): WrenDoc {
  const next = apply(doc, { kind: 'removeFeature', partId: PART, featureId: fid });
  return editPart(next, (part) => {
    for (const c of part.configurations ?? []) if (c.features) delete c.features[fid];
  });
}

/** Removes a document parameter and every configuration's override of it. */
export function removeParam(doc: WrenDoc, pid: string): WrenDoc {
  const next = structuredClone(doc);
  next.params = next.params.filter((p) => p.id !== pid);
  for (const part of next.parts) {
    for (const c of part.configurations ?? []) {
      if (c.params) delete c.params[pid];
      tidyConfiguration(c);
    }
  }
  return next;
}

/** `doc` plus parameter `spare` (5 mm), which no feature uses. */
export function withSpare(doc: WrenDoc): WrenDoc {
  const next = structuredClone(doc);
  next.params.push({ id: P_SPARE, name: 'spare', expr: '5mm' });
  return next;
}

/**
 * Base for the configuration tests: Bracket with configurations Long (width 50 mm) and Short
 * (Fillet 3 suppressed), Default active.
 */
export function configured(doc: WrenDoc): WrenDoc {
  return editPart(withSpare(doc), (part) => {
    part.configurations = [
      { id: LONG, name: 'Long', params: { [P_WIDTH]: '50mm' } },
      { id: SHORT, name: 'Short', features: { [FILLET]: { suppressed: true } } },
    ];
  });
}

/** Override targets of the merged document that no longer exist (should be none). */
export function danglingOverrides(doc: WrenDoc): string[] {
  const out: string[] = [];
  const params = new Set(doc.params.map((p) => p.id));
  for (const part of doc.parts) {
    const features = new Set(part.features.map((f) => f.id));
    for (const c of part.configurations ?? []) {
      for (const p of Object.keys(c.params ?? {})) {
        if (!params.has(p)) out.push(`${c.name}: param ${p}`);
      }
      for (const f of Object.keys(c.features ?? {})) {
        if (!features.has(f)) out.push(`${c.name}: feature ${f}`);
      }
    }
    const active = part.activeConfigurationId;
    if (active !== undefined && !(part.configurations ?? []).some((c) => c.id === active)) {
      out.push(`active ${active}`);
    }
  }
  return out;
}
