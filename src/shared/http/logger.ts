import { pino, type DestinationStream, type Level, type Logger } from 'pino';

// docs/security.md §3: logs never hold tokens, keys, credentials, presigned links, exact coordinates, audit notes or
// the full text of a flag reason. Field names are matched at any depth; a presigned link is caught by its signature
// whatever field carries it.
const CENSOR = '[Redacted]';
const PRESIGNED = /X-Amz-(Signature|Credential)=/i;
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'token',
  'accessToken',
  'idToken',
  'refreshToken',
  'privateKey',
  'secret',
  'password',
  'lat',
  'lon',
  'latitude',
  'longitude',
  'exactLat',
  'exactLon',
  'exact_lat',
  'exact_lon',
  'notes',
  'reportNotes',
  'report_notes',
  'reasonText',
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

// Plain data only: requests, responses and errors keep their pino serializers.
const scrub = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return PRESIGNED.test(value) ? CENSOR : value;
  }

  if (Array.isArray(value)) {
    return value.map(scrub);
  }

  return isPlainObject(value) ? scrubObject(value) : value;
};

const scrubObject = (object: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      SENSITIVE_KEYS.has(key) ? CENSOR : scrub(value),
    ]),
  );

export type LogLevel = Level | 'silent';

export const createLogger = (level: LogLevel, destination?: DestinationStream): Logger =>
  pino(
    {
      level,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: CENSOR,
      },
      formatters: { log: scrubObject },
    },
    destination,
  );
