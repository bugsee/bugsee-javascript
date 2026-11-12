export const ANGULAR_STRIP: RegExp;
export function checkSource(
  code: string,
  format: 'esm' | 'cjs',
  parse: (code: string, format: 'esm' | 'cjs') => void,
): string[];
