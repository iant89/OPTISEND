/**
 * Every reason a packet can be refused. Codes are stable identifiers suitable
 * for diagnostics counters; `detail` is human-readable context.
 */
export type RejectReason =
  | 'too-short'
  | 'bad-magic'
  | 'unsupported-version'
  | 'unsupported-type'
  | 'unsupported-flags'
  | 'unsupported-hash'
  | 'bad-header-length'
  | 'bad-payload-length'
  | 'length-mismatch'
  | 'header-crc'
  | 'header-too-large'
  | 'bad-file-size'
  | 'bad-chunk-size'
  | 'bad-chunk-count'
  | 'bad-chunk-index'
  | 'bad-offset'
  | 'bad-file-name'
  | 'bad-mime'
  | 'bad-manifest'
  | 'chunk-hash-mismatch'
  | 'metadata-conflict'
  | 'limit-exceeded'
  | 'unrecognised-encoding';

export class ProtocolError extends Error {
  constructor(
    readonly reason: RejectReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'ProtocolError';
  }
}
