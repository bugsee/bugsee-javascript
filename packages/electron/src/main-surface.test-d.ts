// The main entry's receiver options expose DecodedReport; it must be nameable from the entry (else the
// declaration bundle leaves it private and consumers hit TS2742).
import type { DecodedReport } from './main';

export const decoded: DecodedReport | undefined = undefined;
