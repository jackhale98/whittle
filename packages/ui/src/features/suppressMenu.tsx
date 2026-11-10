import type { Id } from '@wren-cad/contracts';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import type { MenuItem } from '../components/floating';

/** Where a suppress / unsuppress applies (M3.7, research P0 6). */
export type SuppressScope = 'configuration' | 'all';

/**
 * Configuration awareness for the feature tree (M3.7). Pass it when the part has configurations;
 * the row menu then asks where a suppress applies instead of offering a plain "Suppress".
 * `FeatureTreeItem.suppressed` must be the **effective** state in the active configuration.
 */
export interface FeatureTreeConfiguration {
  /** The active configuration's name. */
  activeName: string;
  /** The active configuration is Default (an edit there applies to every configuration that inherits). */
  isDefault: boolean;
  /** How many configurations the part has besides Default; 0 = behave as without configurations. */
  count: number;
  /** Features whose suppression the active configuration overrides: they carry a marker. */
  overriddenSuppression?: readonly Id[];
  /** Suppress or unsuppress in the chosen scope. Never called with `configuration` while Default is active. */
  onSuppress(id: Id, suppressed: boolean, scope: SuppressScope): void;
  /** Remove the active configuration's suppression override ("Reset to default"). */
  onResetSuppression?(id: Id): void;
}

/**
 * The suppress items of a feature row's menu.
 * - No configurations (`count` 0, or no `configuration`): `null`, the tree keeps its plain item.
 * - Default active: one item, "Suppress in all configurations".
 * - Another active, full mode: "Suppress in this configuration only" and "Suppress in all
 *   configurations", plus "Reset to default suppression" while overridden.
 * - Review mode (phone): one item naming the configuration; it never touches the others.
 */
export function suppressMenuItems(
  cfg: FeatureTreeConfiguration | undefined,
  feature: { id: Id; suppressed: boolean },
  review: boolean,
): MenuItem[] | null {
  if (!cfg || cfg.count <= 0) return null;
  const { id, suppressed } = feature;
  const verb = suppressed ? 'Unsuppress' : 'Suppress';
  const icon = suppressed ? <Eye className="size-4" /> : <EyeOff className="size-4" />;
  const next = !suppressed;
  if (cfg.isDefault) {
    return [
      {
        id: 'suppress-all',
        label: `${verb} in all configurations`,
        hint: 'Configurations that set their own suppression keep it.',
        icon,
        onSelect: () => cfg.onSuppress(id, next, 'all'),
      },
    ];
  }
  if (review) {
    return [
      {
        id: 'suppress-this',
        label: `${verb} in ${cfg.activeName} only`,
        hint: 'Other configurations are not changed.',
        icon,
        onSelect: () => cfg.onSuppress(id, next, 'configuration'),
      },
    ];
  }
  const items: MenuItem[] = [
    {
      id: 'suppress-this',
      label: `${verb} in this configuration only`,
      hint: `Only ${cfg.activeName} changes.`,
      icon,
      onSelect: () => cfg.onSuppress(id, next, 'configuration'),
    },
    {
      id: 'suppress-all',
      label: `${verb} in all configurations`,
      icon,
      onSelect: () => cfg.onSuppress(id, next, 'all'),
    },
  ];
  if (cfg.onResetSuppression && cfg.overriddenSuppression?.includes(id))
    items.push({
      id: 'suppress-reset',
      label: 'Reset to default suppression',
      icon: <RotateCcw className="size-4" />,
      onSelect: () => cfg.onResetSuppression?.(id),
    });
  return items;
}
