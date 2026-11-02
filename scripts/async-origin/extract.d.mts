export interface DomPromiseSnapshot {
  typescript: string;
  interfaces: Record<string, { mixin: boolean; methods: string[] }>;
}
export function extractDomPromiseMethods(libDomPath?: string): DomPromiseSnapshot;
