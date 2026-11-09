import { test } from '@playwright/test';
import { boot } from './helpers';
import { runPart } from './support/reference-ui';

/**
 * M3 acceptance (PLAN §12 M3, §12A): the ten reference parts built entirely through the UI from
 * their spec steps (packages/test-fixtures/reference-parts, README "step format"): command-bar
 * tools, viewport picks at the steps' `at` world points, sketches drawn and dimensioned with
 * typed expressions, inline inspector values, reference chips and the Params table. No document
 * is injected. Each part's mass (mass properties panel) must be within 0.1 % of the spec at the
 * baseline and after every CSWP-style stage (named dimensions changed in Params, then regen).
 */

test.use({ viewport: { width: 1440, height: 900 } });

const PARTS: { id: string; fixme?: string }[] = [
  { id: 'rp01-base-plate' },
  { id: 'rp02-stepped-shaft' },
  { id: 'rp03-ball-knob' },
  { id: 'rp04-clamp-block' },
  { id: 'rp05-moulded-housing' },
  { id: 'rp06-cable-guide' },
  { id: 'rp07-duct-adapter' },
  { id: 'rp08-cover-plate' },
  { id: 'rp09-flanged-hub' },
  { id: 'rp10-comb-plate' },
];

for (const part of PARTS) {
  test(`M3 reference part ${part.id}: built through the UI, mass at every stage`, async ({
    page,
  }, info) => {
    test.slow();
    test.setTimeout(600_000);
    if (part.fixme) test.fixme(true, part.fixme);
    await boot(page);
    const errors = await runPart(page, part.id);
    info.annotations.push({
      type: 'mass error',
      description: errors.map((e) => `${e.stage}: ${(e.error * 100).toFixed(4)} %`).join('; '),
    });
  });
}
