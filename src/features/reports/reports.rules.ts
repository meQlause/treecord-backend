import { z } from 'zod';
import { BPS } from '../../generated/frozen/constants.js';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor.js';

// docs/BE/features/reports.md §1–§2: the report's ratios and the evidence cursor. Amounts are decimal strings and
// divide as bigint (REG-001).

const BPS_BIG = BigInt(BPS);

/** floor(part × 10000 / whole); null when there is no whole yet (an incentive pool before activation, no trees). */
export const ratioBps = (part: string, whole: string | null): number | null =>
  whole === null || whole === '0' ? null : Number((BigInt(part) * BPS_BIG) / BigInt(whole));

export type TreeCounts = {
  planted: number;
  alive: number;
  flagged: number;
  dead: number;
  removed: number;
  completed: number;
};

/** FR-065: trees still standing (alive, flagged, completed) over every tree planted. */
export const survivalRateBps = ({
  planted,
  alive,
  flagged,
  completed,
}: TreeCounts): number | null => ratioBps(String(alive + flagged + completed), String(planted));

export type EvidencePosition = { block: string; logIndex: number };

const evidenceCursorSchema = z.strictObject({
  b: z.string().regex(/^(0|[1-9]\d*)$/),
  l: z.number().int().min(0),
});

/** §2: oldest first by (block_number, log_index); the cursor is the last row's pair. */
export const encodeEvidenceCursor = ({ block, logIndex }: EvidencePosition): string =>
  encodeCursor({ b: block, l: logIndex });

export const decodeEvidenceCursor = (cursor: string): EvidencePosition => {
  const { b, l } = decodeCursor(cursor, evidenceCursorSchema);

  return { block: b, logIndex: l };
};
