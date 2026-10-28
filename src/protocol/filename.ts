/**
 * File names are untrusted metadata (spec §7.2, §12.2). The wire carries the
 * sender's name verbatim (valid UTF-8, length-bounded); this module produces a
 * safe name for storage records and downloads.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const encoder = new TextEncoder();

export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (utf8Length(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = utf8Length(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** Truncate preserving the extension where possible (`very-long-name….pdf`). */
export function truncateFileName(name: string, maxBytes: number): string {
  if (utf8Length(name) <= maxBytes) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const extBytes = utf8Length(ext);
  if (extBytes >= maxBytes) return truncateUtf8(name, maxBytes);
  return truncateUtf8(name.slice(0, name.length - ext.length), maxBytes - extBytes) + ext;
}

/**
 * Produce a name that is safe to offer as a download on any target OS:
 * strips path components, control characters and characters reserved on
 * Windows; avoids reserved device names, leading dots and trailing dots/spaces.
 */
export function sanitizeFileName(name: string, fallback = 'file', maxBytes = 255): string {
  let s = name.normalize('NFC');
  // Drop any path component a hostile sender may have included.
  s = s.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*‪-‮⁦-⁩]/g, '_');
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s === '') s = fallback;
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return truncateFileName(s, maxBytes);
}
