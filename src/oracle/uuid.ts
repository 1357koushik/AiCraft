import crypto from 'crypto';

/** UUID the server assigns to a player when online-mode=false (Java's UUID.nameUUIDFromBytes). */
export function offlinePlayerUuid(name: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Converts the NBT int-array form of a UUID ([I; a, b, c, d]) to the dashed string form. */
export function uuidFromIntArray(ints: number[]): string {
  if (ints.length !== 4) throw new Error(`UUID int array must have 4 elements, got ${ints.length}`);
  const hex = ints.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parses the text a datapack macro prints for a UUID int array, e.g. "[I;1,-2,3,4]" or "[I; 1, -2, 3, 4]". */
export function uuidFromIntArrayText(text: string): string | null {
  const match = text.match(/^\[I;\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\]$/);
  if (!match) return null;
  return uuidFromIntArray(match.slice(1, 5).map((n) => parseInt(n, 10)));
}
