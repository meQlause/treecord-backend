// One builder per job kind: how to simulate and send its contract call, with the ABI typed per contract.
import type { Abi, Account, Address, Hex, PublicClient } from 'viem';
import {
  campaignAbi,
  carbonLedgerAbi,
  treeRegistryAbi,
  verificationGatewayAbi,
} from '../../generated/frozen/abis/index.js';
import type { TreecordDeployment } from '../../generated/frozen/addresses.js';
import {
  deserializeAttestation,
  type SerializedAttestation,
} from '../../generated/frozen/attester.js';
import {
  anchorAssignJobPayloadSchema,
  claimJobPayloadSchema,
  estimateJobPayloadSchema,
  issueJobPayloadSchema,
  resolveFlagJobPayloadSchema,
  setPriceJobPayloadSchema,
  type AttestationJobPayload,
} from '../../generated/frozen/jobs.js';
import type { Wallet } from '../../shared/chain/wallets.js';
import type { JobKind } from './state.rules.js';

export type PreparedCall = {
  /** Which wallet sends it. */
  wallet: 'operator' | 'relayer';
  /** For logs. */
  description: string;
  /** Throws the contract revert if the call would fail now. */
  simulate: (client: PublicClient, account: Account) => Promise<unknown>;
  send: (wallet: Wallet, nonce: number) => Promise<Hex>;
};

/** Thrown for a payload that fails its schema. The job fails without retrying. */
export class InvalidPayloadError extends Error {
  constructor(kind: string, issues: string) {
    super(`Invalid ${kind} job payload: ${issues}`);
    this.name = 'InvalidPayloadError';
  }
}

type Schema<Parsed> = {
  safeParse: (value: unknown) => { success: true; data: Parsed } | { success: false; error: Error };
};

export const parsePayload = <Parsed>(
  schema: Schema<Parsed>,
  kind: string,
  payload: unknown,
): Parsed => {
  const result = schema.safeParse(payload);

  if (!result.success) {
    throw new InvalidPayloadError(kind, result.error.message);
  }

  return result.data;
};

/** A call of `functionName` on `address`, simulated as `account` and sent by the lane's wallet. */
export const contractCall = (
  wallet: PreparedCall['wallet'],
  description: string,
  target: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
): PreparedCall => ({
  wallet,
  description,
  simulate: (client, account) => client.simulateContract({ ...target, account } as never),
  send: (sender, nonce) => sender.writeContract({ ...target, nonce } as never),
});

type Builder = (payload: unknown, deployment: TreecordDeployment) => PreparedCall;

const slotsCall =
  (kind: 'claim' | 'anchor_assign'): Builder =>
  (payload) => {
    const parsed = parsePayload(
      kind === 'claim' ? claimJobPayloadSchema : anchorAssignJobPayloadSchema,
      kind,
      payload,
    );
    const functionName = kind === 'claim' ? 'claimSlotsFor' : 'assignAnchorSlots';

    return contractCall(
      'operator',
      `${functionName}(${parsed.planter}, ${parsed.count}) on ${parsed.campaign}`,
      {
        address: parsed.campaign as Address,
        abi: campaignAbi,
        functionName,
        args: [parsed.planter as Address, parsed.count],
      },
    );
  };

const OPERATOR_BUILDERS: Partial<Record<JobKind, Builder>> = {
  claim: slotsCall('claim'),
  anchor_assign: slotsCall('anchor_assign'),
  estimate: (payload, deployment) => {
    const parsed = parsePayload(estimateJobPayloadSchema, 'estimate', payload);

    return contractCall('operator', `setEstimate(${parsed.campaign}, ${parsed.estimatedAmount})`, {
      address: deployment.carbonLedger,
      abi: carbonLedgerAbi,
      functionName: 'setEstimate',
      args: [parsed.campaign as Address, BigInt(parsed.estimatedAmount)],
    });
  },
  issue: (payload, deployment) => {
    const parsed = parsePayload(issueJobPayloadSchema, 'issue', payload);

    return contractCall(
      'operator',
      `issueBatch(${parsed.campaign}, ${parsed.registry} ${parsed.serialStart}..${parsed.serialEnd}, ${parsed.amount})`,
      {
        address: deployment.carbonLedger,
        abi: carbonLedgerAbi,
        functionName: 'issueBatch',
        args: [
          parsed.campaign as Address,
          parsed.registry,
          parsed.serialStart,
          parsed.serialEnd,
          parsed.vintage,
          BigInt(parsed.amount),
        ],
      },
    );
  },
  set_price: (payload, deployment) => {
    const parsed = parsePayload(setPriceJobPayloadSchema, 'set_price', payload);

    return contractCall('operator', `setPrice(${parsed.batchId}, ${parsed.usdcPerTonne})`, {
      address: deployment.carbonLedger,
      abi: carbonLedgerAbi,
      functionName: 'setPrice',
      args: [BigInt(parsed.batchId), BigInt(parsed.usdcPerTonne)],
    });
  },
  resolve_flag: (payload, deployment) => {
    const parsed = parsePayload(resolveFlagJobPayloadSchema, 'resolve_flag', payload);

    return contractCall(
      'operator',
      `resolveFlag(${parsed.treeId}, ${parsed.uphold ? 'uphold' : 'dismiss'})`,
      {
        address: deployment.treeRegistry,
        abi: treeRegistryAbi,
        functionName: 'resolveFlag',
        args: [BigInt(parsed.treeId), parsed.uphold, parsed.noteHash as Hex],
      },
    );
  },
};

/** Calls for the operator lane: claim, anchor_assign, estimate, issue, set_price, resolve_flag. */
export const operatorCall = (
  kind: JobKind,
  payload: unknown,
  deployment: TreecordDeployment,
): PreparedCall => {
  const build = OPERATOR_BUILDERS[kind];

  if (!build) {
    throw new Error(`${kind} jobs are not sent by the operator lane`);
  }

  return build(payload, deployment);
};

/** VerificationGateway.submit for one attestation, or submitBatch for several (all or nothing). */
export const attestationCall = (
  payloads: AttestationJobPayload[],
  deployment: TreecordDeployment,
): PreparedCall => {
  const attestations = payloads.map((payload) =>
    deserializeAttestation(payload.attestation as SerializedAttestation),
  );
  const signatures = payloads.map((payload) => payload.signature as Hex);
  const [first] = attestations;
  const [firstSignature] = signatures;
  const target = { address: deployment.verificationGateway, abi: verificationGatewayAbi };

  if (attestations.length === 1 && first && firstSignature) {
    return contractCall('relayer', `submit(nonce ${first.nonce})`, {
      ...target,
      functionName: 'submit',
      args: [first, firstSignature],
    });
  }

  return contractCall('relayer', `submitBatch(${attestations.length} attestations)`, {
    ...target,
    functionName: 'submitBatch',
    args: [attestations, signatures],
  });
};
