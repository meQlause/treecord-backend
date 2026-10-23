import {
  CHECK_IN_RADIUS_M,
  MAX_FUTURE_CAPTURE_MS,
  MAX_GPS_ACCURACY_M,
  UPLOAD_WINDOW_MS,
} from '../../../generated/frozen/constants.js';
import { haversineMeters } from '../../../generated/frozen/evidence.js';
import { isoInstant } from '../../../shared/instant.js';
import { duration, row, targetChecks, type CheckRow, type TargetFacts } from './prechecks.rules.js';

// docs/BE/features/evidence-prechecks.md §1 "Submit": all fifteen checks, the facts loaded once by the service (§3).

// how much of a key or hash S21 prints before the ellipsis
const DEVICE_SHOWN = 10;
const HASH_SHOWN = 12;
const TARGET_ONLY = new Set(['challenge', 'tag']);
const thousands = new Intl.NumberFormat('en-US');

export type SubmitFacts = TargetFacts & {
  callerProfileId: string;
  /** The device whose thumbprint the payload names, or null when none is registered. */
  device: { profileId: string; revoked: boolean } | null;
  /** The sent canonical string is the server's canonicalization of the payload. */
  canonicalMatches: boolean;
  /** The ECDSA signature verifies over the canonical bytes with the device key. */
  verified: boolean;
  /** SHA-256 the API streamed from the stored object. */
  storedSha256: string;
  payload: {
    deviceKey: string;
    videoSha256: string;
    lat: number;
    lon: number;
    acc: number;
    capturedAt: number;
    challenge: string | null;
    tag?: string | null;
  };
  /** The server clock at this request (FR-133, challenge expiry). */
  now: number;
  /** PLANTED: the campaign centre and radius; others: the tree's first location. Null when missing. */
  reference: { lat: number; lon: number } | null;
  radiusM: number;
  durationSec: number | null;
};

/** §2 check 1: an active device of this account. */
const device = ({ device: known, callerProfileId, payload }: SubmitFacts): CheckRow => {
  const judged = {
    value: `${payload.deviceKey.slice(0, DEVICE_SHOWN)}…`,
    limit: 'active device of this account',
  };

  if (known === null || known.revoked) {
    return row('device', false, { ...judged, reason: 'device_unknown_or_revoked' });
  }

  return row('device', known.profileId === callerProfileId, {
    ...judged,
    reason: 'device_not_owned',
  });
};

/** §2 check 2: the canonical string is the payload's, and the device signed it; not checked without a device. */
const signature = ({ device: known, canonicalMatches, verified }: SubmitFacts): CheckRow => {
  const judged = { value: 'ECDSA P-256', limit: 'signature over the canonical payload' };

  if (known === null && canonicalMatches) {
    return { check: 'signature', ok: null, ...judged, reason: null };
  }

  return row('signature', canonicalMatches && verified, { ...judged, reason: 'signature_invalid' });
};

const videoHash = ({ storedSha256, payload }: SubmitFacts): CheckRow =>
  row('video_hash', storedSha256 === payload.videoSha256, {
    value: `${storedSha256.slice(0, HASH_SHOWN)}…`,
    limit: 'equals the signed SHA-256',
    reason: 'hash_mismatch',
  });

/** §2 check 4 at submit: the row itself holds the hash under its unique key, so it passes. */
const uniqueVideo = (): CheckRow => ({
  check: 'unique_video',
  ok: true,
  value: 'first use',
  limit: 'unused by any earlier submission',
  reason: null,
});

/** §2 check 5: at most 72 h old and 5 min ahead of the server clock, both edges passing (FR-133, FR-110). */
const captureTime = ({ payload, now }: SubmitFacts): CheckRow => {
  const judged = { value: isoInstant(payload.capturedAt), limit: '≤ 72 h old, ≤ 5 min ahead' };

  if (payload.capturedAt - now > MAX_FUTURE_CAPTURE_MS) {
    return row('capture_time', false, { ...judged, reason: 'future_capture' });
  }

  return row('capture_time', now - payload.capturedAt <= UPLOAD_WINDOW_MS, {
    ...judged,
    reason: 'stale_capture',
  });
};

const gpsAccuracy = ({ payload }: SubmitFacts): CheckRow =>
  row('gps_accuracy', payload.acc <= MAX_GPS_ACCURACY_M, {
    value: `${payload.acc.toFixed(1)} m`,
    limit: `≤ ${MAX_GPS_ACCURACY_M} m`,
    reason: 'gps_inaccurate',
  });

/** §2 check 7: within the campaign radius for a planting, 15 m of the tree otherwise; a missing reference fails. */
const location = ({ kind, payload, reference, radiusM }: SubmitFacts): CheckRow => {
  const planting = kind === 'PLANTED';
  const reason = planting ? 'outside_region' : 'moved_tree';
  const limit = planting
    ? `≤ ${thousands.format(radiusM)} m from center`
    : `≤ ${CHECK_IN_RADIUS_M} m from the planting`;

  if (reference === null) {
    return row('location', false, {
      value: planting ? 'no region center' : 'no planting location',
      limit,
      reason,
    });
  }

  const meters = haversineMeters(payload, reference);

  return row('location', meters <= radiusM, {
    value: planting ? `${Math.round(meters)} m from center` : `${meters.toFixed(1)} m away`,
    limit,
    reason,
  });
};

/** §2 check 14 at submit: an open challenge must be carried; none open passes (FR-139). */
const challenge = ({ openChallengeCode: code, payload }: SubmitFacts): CheckRow =>
  code === null
    ? { check: 'challenge', ok: true, value: 'none open', limit: 'no open challenge', reason: null }
    : row('challenge', payload.challenge === code, {
        value: payload.challenge ?? 'none',
        limit: `carries ${code}`,
        reason: 'challenge_missing',
      });

/** §2 check 15 at submit: a tag was issued and the payload carries it (FR-140). */
const tag = ({ issuedTag, payload }: SubmitFacts): CheckRow => {
  if (issuedTag === null) {
    return row('tag', false, {
      value: 'none',
      limit: 'a tag issued to the target',
      reason: 'tag_missing',
    });
  }

  return row('tag', payload.tag === issuedTag, {
    value: payload.tag ?? 'none',
    limit: `issued tag ${issuedTag}`,
    reason: 'tag_mismatch',
  });
};

/** §1 "Submit": every check in FR-130 order; the target rows are judged as at the target, then the submit forms of
 *  the challenge and the tag. */
export const submitChecks = (facts: SubmitFacts): CheckRow[] => [
  device(facts),
  signature(facts),
  videoHash(facts),
  uniqueVideo(),
  captureTime(facts),
  gpsAccuracy(facts),
  location(facts),
  duration(facts),
  ...targetChecks(facts).filter((checked) => !TARGET_ONLY.has(checked.check)),
  ...(facts.kind === 'PLANTED' ? [] : [challenge(facts)]),
  tag(facts),
];
