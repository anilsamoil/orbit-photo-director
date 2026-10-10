export interface ReintroductionPattern {
  name: string;
  css?: string;
  js?: string;
}
export function ownerPlacementViolations(css: string, js?: string, options?: { owner?: boolean }): string[];
export function jsPlacementViolations(js: string, options?: { owner?: boolean }): string[];
export function narrowPlacementViolations(css: string, js?: string): string[];
export function projectPlacementViolations(root: string, overrides?: Map<string, string>): string[];
export const REINTRODUCTION_PATTERNS: ReintroductionPattern[];
export function reintroductionMisses(patterns?: ReintroductionPattern[]): string[];
