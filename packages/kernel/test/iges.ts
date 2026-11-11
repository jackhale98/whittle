/**
 * Minimal IGES 5.3 writer for kernel tests: an axis-aligned box as six bounded planes (entity
 * 108 form 1), each bounded by a composite curve (102) of four lines (110). This is how many
 * surface modellers export solids, so the reader has to sew the faces into a solid.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type Vec3 = [number, number, number];

interface Entity {
  type: number;
  form: number;
  params: (string | number)[];
  subordinate: boolean;
}

const real = (v: number): string => (Number.isInteger(v) ? `${v}.` : String(v));

const field = (v: string | number, width = 8): string => String(v).padStart(width, ' ');

function line(text: string, section: string, seq: number): string {
  return `${text.padEnd(72, ' ')}${section}${String(seq).padStart(7, ' ')}`;
}

/** Splits a parameter record into ≤ 64-column chunks at delimiters. */
function chunks(record: string): string[] {
  const out: string[] = [];
  let rest = record;
  while (rest.length > 64) {
    let cut = rest.lastIndexOf(',', 63);
    if (cut < 0) cut = 63;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  out.push(rest);
  return out;
}

const hollerith = (s: string): string => `${s.length}H${s}`;

/**
 * IGES text of the box [0,dx]×[0,dy]×[0,dz] (mm). `faceCount` < 6 writes only the first faces
 * (x min, x max, y min, y max, z min, z max): an open surface model. `splitTopAt` (0 < x < dx)
 * writes the top as two coplanar faces split at that x (the y faces get the split vertex), a body
 * no boolean makes any more since they merge coplanar faces (ADR-078).
 */
export function igesBox(
  dx: number,
  dy: number,
  dz: number,
  faceCount = 6,
  splitTopAt?: number,
): string {
  const entities: Entity[] = [];
  const add = (e: Entity): number => {
    entities.push(e);
    return 2 * entities.length - 1; // DE pointer of the entity's first directory line
  };
  const faces: { plane: [number, number, number, number]; loop: Vec3[] }[] = [
    {
      plane: [-1, 0, 0, 0],
      loop: [
        [0, 0, 0],
        [0, 0, dz],
        [0, dy, dz],
        [0, dy, 0],
      ],
    },
    {
      plane: [1, 0, 0, dx],
      loop: [
        [dx, 0, 0],
        [dx, dy, 0],
        [dx, dy, dz],
        [dx, 0, dz],
      ],
    },
    {
      plane: [0, -1, 0, 0],
      loop: [
        [0, 0, 0],
        [dx, 0, 0],
        [dx, 0, dz],
        [0, 0, dz],
      ],
    },
    {
      plane: [0, 1, 0, dy],
      loop: [
        [0, dy, 0],
        [0, dy, dz],
        [dx, dy, dz],
        [dx, dy, 0],
      ],
    },
    {
      plane: [0, 0, -1, 0],
      loop: [
        [0, 0, 0],
        [0, dy, 0],
        [dx, dy, 0],
        [dx, 0, 0],
      ],
    },
    {
      plane: [0, 0, 1, dz],
      loop: [
        [0, 0, dz],
        [dx, 0, dz],
        [dx, dy, dz],
        [0, dy, dz],
      ],
    },
  ];
  const written = faces.slice(0, faceCount);
  if (splitTopAt !== undefined && faceCount === 6) {
    const s = splitTopAt;
    (written[2] as (typeof faces)[number]).loop.splice(3, 0, [s, 0, dz]);
    (written[3] as (typeof faces)[number]).loop.splice(2, 0, [s, dy, dz]);
    written[5] = {
      plane: [0, 0, 1, dz],
      loop: [
        [0, 0, dz],
        [s, 0, dz],
        [s, dy, dz],
        [0, dy, dz],
      ],
    };
    written.push({
      plane: [0, 0, 1, dz],
      loop: [
        [s, 0, dz],
        [dx, 0, dz],
        [dx, dy, dz],
        [s, dy, dz],
      ],
    });
  }
  for (const f of written) {
    const lines = f.loop.map((a, i) => {
      const b = f.loop[(i + 1) % f.loop.length] as Vec3;
      return add({ type: 110, form: 0, params: [...a, ...b].map(real), subordinate: true });
    });
    const curve = add({ type: 102, form: 0, params: [lines.length, ...lines], subordinate: true });
    const [a, b, c, d] = f.plane;
    add({
      type: 108,
      form: 1,
      params: [real(a), real(b), real(c), real(d), curve, '0.', '0.', '0.', '0.'],
      subordinate: false,
    });
  }

  const out: string[] = [line('Wren kernel test fixture: box as bounded planes', 'S', 1)];
  const date = '20261109.000000';
  const global = [
    '1H,',
    '1H;',
    hollerith('wren'),
    hollerith('box.igs'),
    hollerith('wren'),
    hollerith('test'),
    '32',
    '38',
    '6',
    '308',
    '15',
    hollerith('wren'),
    '1.',
    '2',
    '2HMM',
    '1',
    '1.',
    hollerith(date),
    '1.0E-6',
    real(Math.max(dx, dy, dz) * 2),
    hollerith('test'),
    hollerith('wren'),
    '11',
    '0',
    hollerith(date),
  ].join(',');
  const globalLines = chunks(`${global};`).map((t, i) => line(t, 'G', i + 1));
  out.push(...globalLines);

  const directory: string[] = [];
  const parameters: string[] = [];
  entities.forEach((e, i) => {
    const de = 2 * i + 1;
    const record = `${[e.type, ...e.params].join(',')};`;
    const pieces = chunks(record);
    const pStart = parameters.length + 1;
    for (const p of pieces) {
      const seq = parameters.length + 1;
      parameters.push(`${p.padEnd(64, ' ')}${field(de)}P${String(seq).padStart(7, ' ')}`);
    }
    const status = e.subordinate ? '00010000' : '00000000';
    directory.push(
      line([e.type, pStart, 0, 0, 0, 0, 0, 0].map((v) => field(v)).join('') + status, 'D', de),
    );
    directory.push(
      line(
        [e.type, 0, 0, pieces.length, e.form, '', '', ''].map((v) => field(v)).join('') + field(0),
        'D',
        de + 1,
      ),
    );
  });
  out.push(...directory, ...parameters);
  const terminate = `S${field(1, 7)}G${field(globalLines.length, 7)}D${field(directory.length, 7)}P${field(parameters.length, 7)}`;
  out.push(line(terminate, 'T', 1));
  return `${out.join('\n')}\n`;
}
