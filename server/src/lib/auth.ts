import { timingSafeEqual } from 'node:crypto';

export function checkBearer(header: string | string[] | undefined, expectedToken: string): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || !expectedToken) return false;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!match?.[1]) return false;
  const provided = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function isValidDeviceId(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_.:-]{8,128}$/.test(value);
}
