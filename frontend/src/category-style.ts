export interface CategoryPaint {
  label: string;
  color: string;
  ink: string;
}

export const ANILS_TARGETS_CATEGORY = 'anils-targets';

/** Light indigo. It stays off the score ramp (red, gold, green), the
 *  illumination legend (cyan, magenta, slate), launch orange, and the
 *  photo-lookup pink. Dark ink keeps the chip readable on the fill. */
export const ANILS_TARGET_PAINT: CategoryPaint = {
  label: "Anil's targets",
  color: '#8b93ff',
  ink: '#12142b',
};

const CATEGORY_PAINT: Readonly<Record<string, CategoryPaint>> = {
  [ANILS_TARGETS_CATEGORY]: ANILS_TARGET_PAINT,
};

export function categoryPaint(category: string | undefined): CategoryPaint | undefined {
  if (!category) return undefined;
  return CATEGORY_PAINT[category];
}
