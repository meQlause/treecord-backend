// The worker's viem clients (ADR-021): a public client and the two wallets that send transactions. Only
// src/shared/chain/ creates viem clients; the API never holds these keys (ADR-014).
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, foundry } from 'viem/chains';
import {
  campaignAbi,
  campaignFactoryAbi,
  carbonLedgerAbi,
  treecordRolesAbi,
  treeRegistryAbi,
  verificationGatewayAbi,
} from '../../generated/frozen/abis/index.js';
import { ANVIL_CHAIN_ID } from '../../generated/frozen/constants.js';

type AbiError = Extract<Abi[number], { type: 'error' }>;

export type Wallet = WalletClient<Transport, Chain, Account>;

export type ChainClients = {
  public: PublicClient;
  /** OPERATOR_ROLE and ISSUER_ROLE calls, and the scheduled maintenance calls. */
  operator: Wallet;
  /** Attestation submits. */
  relayer: Wallet;
};

const TRANSPORT = { retryCount: 2, timeoutMs: 20_000, pollingIntervalMs: 1_000 };

const chainFor = (chainId: number): Chain => (chainId === ANVIL_CHAIN_ID ? foundry : baseSepolia);

export const createChainClients = (options: {
  rpcUrl: string;
  chainId: number;
  operatorKey: Hex;
  relayerKey: Hex;
  pollingIntervalMs?: number;
}): ChainClients => {
  const chain = chainFor(options.chainId);
  const transport = http(options.rpcUrl, {
    retryCount: TRANSPORT.retryCount,
    timeout: TRANSPORT.timeoutMs,
  });
  const pollingInterval = options.pollingIntervalMs ?? TRANSPORT.pollingIntervalMs;
  const wallet = (key: Hex): Wallet =>
    createWalletClient({ account: privateKeyToAccount(key), chain, transport, pollingInterval });

  return {
    public: createPublicClient({ chain, transport, pollingInterval }) as PublicClient,
    operator: wallet(options.operatorKey),
    relayer: wallet(options.relayerKey),
  };
};

/** Every custom error any Treecord contract can revert with, so nested reverts decode too. */
const treecordErrorsAbi: AbiError[] = [
  ...new Map(
    [
      treecordRolesAbi,
      campaignFactoryAbi,
      campaignAbi,
      treeRegistryAbi,
      verificationGatewayAbi,
      carbonLedgerAbi,
    ]
      .flatMap((abi) => [...(abi as Abi)])
      .filter((item): item is AbiError => item.type === 'error')
      .reverse()
      .map((item) => [item.name, item] as const),
  ).values(),
];

const decodeRaw = (raw: Hex): string | null => {
  try {
    return decodeErrorResult({ abi: treecordErrorsAbi, data: raw }).errorName;
  } catch {
    return null;
  }
};

/** The custom error name of a contract revert (for example `NonceAlreadyUsed`), or null for other failures. */
export const revertErrorName = (error: unknown): string | null => {
  if (!(error instanceof BaseError)) {
    return null;
  }

  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);

  if (!(reverted instanceof ContractFunctionRevertedError)) {
    return null;
  }

  if (reverted.data?.errorName) {
    return reverted.data.errorName;
  }

  return reverted.raw && reverted.raw !== '0x' ? decodeRaw(reverted.raw) : null;
};

/** A short, single-line description of an error for logs and `last_error`. */
export const describeError = (error: unknown): string => {
  const name = revertErrorName(error);

  if (name) {
    return `reverted: ${name}`;
  }

  if (error instanceof BaseError) {
    return error.shortMessage;
  }

  return error instanceof Error ? error.message : String(error);
};
