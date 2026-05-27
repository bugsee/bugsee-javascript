import type { FileType } from '@bugsee/protocol';
import type { CaptureDataEntry, CaptureEntryFactory } from './contracts';

// The default JSON CaptureDataEntry (Android BugseeCaptureDataEntryBase parity). serialize() encodes
// {timestamp, data} as JSON; deserialize() restores them into this instance (Android-style instance
// deserialize). Concrete entry types with a custom format (e.g. binary network bodies on a platform
// tier) subclass and override serialize/deserialize.

export class CaptureDataEntryBase implements CaptureDataEntry {
  constructor(
    public readonly type: FileType,
    public timestamp = 0,
    public data: unknown = undefined,
  ) {}

  serialize(): string {
    return JSON.stringify({ timestamp: this.timestamp, data: this.data });
  }

  deserialize(serialized: string): void {
    const parsed = JSON.parse(serialized) as { timestamp: number; data: unknown };
    this.timestamp = parsed.timestamp;
    this.data = parsed.data;
  }
}

/** Default factory: an empty JSON entry for any file type, for the exporter to deserialize into. */
export const defaultEntryFactory: CaptureEntryFactory = (type: FileType) =>
  new CaptureDataEntryBase(type);
