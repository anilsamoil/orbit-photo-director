export const R8_PLACEMENT_MUTANTS: Array<{ name: string; clean: string; files: Record<string, string> }>;
export const PLACEMENT_DIAGNOSTIC: RegExp;
export function mutantSyntaxDiagnostics(files: Record<string, string>): string[];
