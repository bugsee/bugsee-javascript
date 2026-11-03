export interface DomPromiseSnapshot {
  typescript: string;
  interfaces: Record<string, { mixin: boolean; methods: string[] }>;
  statics: Record<string, string[]>;
  constructors: string[];
}
export function extractDomPromiseMethods(libDomPath?: string): DomPromiseSnapshot;
