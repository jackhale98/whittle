// SPDX-License-Identifier: GPL-3.0-or-later
import { zipSync } from 'fflate';
import { IoError } from './errors';
import { checkMesh, fmt, type MeshReport, type NamedMesh, parseColor, weldMesh } from './mesh';

const NS_CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_MODEL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/** Fixed (local-time) DOS timestamp so archives are byte-reproducible in any time zone. */
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

export interface ThreeMfOptions {
  /** Weld tolerance in mm (default 1e-4). */
  tolerance?: number;
  /** Receives one report per exported body (e.g. to surface "not watertight" warnings). */
  onReport?: (name: string, report: MeshReport) => void;
}

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** Strip characters that are illegal in XML 1.0. */
function xmlSafe(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally removing control chars
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Build a 3MF package (core spec 1.x): one `<object type="model">` per body, vertices welded so
 * the mesh is manifold, optional `<basematerials>` colour, unit millimeter.
 *
 * Throws `IoError('malformed')` if a body has triangles referencing missing vertices; degenerate
 * triangles are dropped silently (counted in the report).
 */
export function to3mf(
  bodies: NamedMesh[],
  unit: 'millimeter' = 'millimeter',
  options: ThreeMfOptions = {},
): Uint8Array {
  if (unit !== 'millimeter')
    throw new IoError('unsupported', `3MF unit "${unit}" is not supported`);
  let nextId = 1;
  const resources: string[] = [];
  const items: string[] = [];
  bodies.forEach((body, bi) => {
    const { positions, indices } = body.mesh;
    let welded: ReturnType<typeof weldMesh>;
    try {
      welded = weldMesh(positions, indices, options.tolerance);
    } catch (e) {
      throw new IoError('malformed', `Body "${body.name}": ${(e as Error).message}`);
    }
    const report = checkMesh(welded.vertices, welded.triangles);
    options.onReport?.(body.name, report);
    if (welded.triangles.length === 0) return; // nothing printable; skip empty bodies
    const rgb = parseColor(body.color);
    let pidAttr = '';
    if (rgb) {
      const mid = nextId++;
      resources.push(
        `<basematerials id="${mid}"><base name="${xmlEscape(xmlSafe(body.name || `Body ${bi + 1}`))}" displaycolor="#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}FF"/></basematerials>`,
      );
      pidAttr = ` pid="${mid}" pindex="0"`;
    }
    const oid = nextId++;
    const v: string[] = [];
    for (let i = 0; i < welded.vertices.length; i += 3) {
      v.push(
        `<vertex x="${fmt(welded.vertices[i] as number)}" y="${fmt(welded.vertices[i + 1] as number)}" z="${fmt(welded.vertices[i + 2] as number)}"/>`,
      );
    }
    const t: string[] = [];
    for (let i = 0; i < welded.triangles.length; i += 3) {
      t.push(
        `<triangle v1="${welded.triangles[i]}" v2="${welded.triangles[i + 1]}" v3="${welded.triangles[i + 2]}"/>`,
      );
    }
    const name = xmlEscape(xmlSafe(body.name || `Body ${bi + 1}`));
    resources.push(
      `<object id="${oid}" name="${name}" type="model"${pidAttr}><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`,
    );
    items.push(`<item objectid="${oid}"/>`);
  });

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="${unit}" xml:lang="en-US" xmlns="${NS_CORE}">` +
    `<metadata name="Application">Wren</metadata>` +
    `<resources>${resources.join('')}</resources>` +
    `<build>${items.join('')}</build></model>\n`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="${NS_CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>\n`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${REL_MODEL}"/>` +
    `</Relationships>\n`;
  const enc = new TextEncoder();
  const opts = { mtime: ZIP_EPOCH, level: 6 } as const;
  // [Content_Types].xml must come first; object key order is preserved by fflate.
  return zipSync({
    '[Content_Types].xml': [enc.encode(contentTypes), opts],
    '_rels/.rels': [enc.encode(rels), opts],
    '3D/3dmodel.model': [enc.encode(model), opts],
  });
}
