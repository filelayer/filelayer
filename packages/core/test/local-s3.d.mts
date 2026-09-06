/** Types for the JS test harness. Test-only; excluded from LOC counts. */
export interface LocalS3Object {
  body: Buffer;
  contentType: string;
  lastModified: Date;
}
export interface LocalS3LogEntry {
  method: string;
  key: string;
  query: Record<string, string>;
  presigned: boolean;
  at: number;
}
export interface LocalS3 {
  server: import('node:http').Server;
  objects: Map<string, LocalS3Object>;
  uploads: Map<string, unknown>;
  requestLog: LocalS3LogEntry[];
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
  endpoint(): string;
  bucket: string;
  deactivateAccessKey(id: string): void;
  activateAccessKey(id: string): void;
  injectFault(f: { key?: string; method?: string; status?: number; code?: string }): void;
  clearFaults(): void;
}
export function createLocalS3(opts: {
  accessKeyId: string;
  secretAccessKey: string;
  bucket?: string;
  now?: () => number;
}): LocalS3;
