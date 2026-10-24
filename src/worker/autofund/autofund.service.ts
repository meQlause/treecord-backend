// Testnet only (AUTO_FUND): a campaign still funding is filled by the operator wallet, so a new campaign turns active
// without a donor. One campaign per pass: mint the USDC the operator lacks, approve the campaign, contribute the rest.
// Each call is simulated, sent with the operator's local nonce and its receipt awaited before the next; a campaign
// whose pass fails is left alone for a while, like the scheduler's skipped tasks.
import { erc20Abi, parseAbi, type Address, type Hex } from 'viem';
import { campaignAbi } from '../../generated/frozen/abis/index.js';
import type { TreecordDeployment } from '../../generated/frozen/addresses.js';
import { describeError, revertErrorName, type ChainClients } from '../../shared/chain/wallets.js';
import type { Metrics } from '../metrics.js';
import { contractCall, type PreparedCall } from '../relayer/calls.rules.js';
import type { NonceManager } from '../relayer/nonces.js';
import { query, type Db, type Logger } from '../worker-db.repository.js';
import { fundingSteps, type FundingStep } from './autofund.rules.js';

export type AutoFunderOptions = {
  db: Db;
  clients: ChainClients;
  deployment: TreecordDeployment;
  nonces: NonceManager;
  log: Logger;
  metrics: Metrics;
  receiptTimeoutMs?: number;
};

// MockUSDC's open mint (contracts/test/mocks/MockUSDC.sol); only the testnet deployments have it
const mockUsdcAbi = parseAbi(['function mint(address to, uint256 amount)']);
const SKIP_AFTER_FAILURE_MS = 600_000;
const RECEIPT_TIMEOUT_MS = 90_000;

export class AutoFunder {
  private readonly skipUntil = new Map<string, number>();

  constructor(private readonly options: AutoFunderOptions) {}

  /** Fills at most one campaign. True when one was filled, so the loop runs again at once for the next. */
  async tick(): Promise<boolean> {
    const campaign = await this.nextCampaign();

    if (campaign === null) {
      return false;
    }

    try {
      await this.fill(campaign);
      this.options.metrics.inc('autofund.filled');

      return true;
    } catch (error) {
      this.skipUntil.set(campaign, Date.now() + SKIP_AFTER_FAILURE_MS);
      this.options.log.warn(
        { campaign, reason: revertErrorName(error) ?? describeError(error) },
        'auto-fund skipped',
      );

      return false;
    }
  }

  /** The oldest campaign of this chain still funding, not full, before its deadline, and not being skipped. */
  private async nextCampaign(): Promise<Address | null> {
    const rows = await query<{ address: string }>(
      this.options.db,
      'load campaigns to auto-fund',
      `select address from public.campaigns
       where chain_id = $1 and status = 'funding' and funding_deadline > now()
         and funded_amount::numeric < funding_target::numeric
       order by created_at`,
      [this.options.deployment.chainId],
    );
    const now = Date.now();
    const next = rows.find((row) => (this.skipUntil.get(row.address) ?? 0) <= now);

    return next === undefined ? null : (next.address as Address);
  }

  private async fill(campaign: Address): Promise<void> {
    const { clients, deployment, log } = this.options;
    const operator = clients.operator.account.address;
    const chain = clients.public;
    // the target lives in the campaign's config struct; totalRaised is its own getter
    const [config, raised, balance, allowance] = await Promise.all([
      chain.readContract({ address: campaign, abi: campaignAbi, functionName: 'config' }),
      chain.readContract({ address: campaign, abi: campaignAbi, functionName: 'totalRaised' }),
      chain.readContract({
        address: deployment.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [operator],
      }),
      chain.readContract({
        address: deployment.usdc,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [operator, campaign],
      }),
    ]);
    const remaining = config.fundingTarget - raised;

    for (const step of fundingSteps({ remaining, balance, allowance })) {
      const hash = await this.send(this.callFor(campaign, step));

      log.info(
        { campaign, step: step.kind, amount: step.amount.toString(), tx: hash },
        'auto-fund call confirmed',
      );
    }
  }

  private callFor(campaign: Address, step: FundingStep): PreparedCall {
    const { usdc } = this.options.deployment;
    const operator = this.options.clients.operator.account.address;
    const description = `auto-fund ${step.kind} ${step.amount} for ${campaign}`;

    switch (step.kind) {
      case 'mint':
        return contractCall('operator', description, {
          address: usdc,
          abi: mockUsdcAbi,
          functionName: 'mint',
          args: [operator, step.amount],
        });
      case 'approve':
        return contractCall('operator', description, {
          address: usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [campaign, step.amount],
        });
      case 'contribute':
        return contractCall('operator', description, {
          address: campaign,
          abi: campaignAbi,
          functionName: 'contribute',
          args: [step.amount],
        });
    }
  }

  /** Simulates, sends and waits for one call; throws when it would revert, was not sent or did not succeed. */
  private async send(call: PreparedCall): Promise<Hex> {
    const { clients, nonces } = this.options;
    const operator = clients.operator;

    await call.simulate(clients.public, operator.account);

    const hash = await nonces.withNonce(operator.account.address, (nonce) =>
      call.send(operator, nonce),
    );
    const receipt = await clients.public.waitForTransactionReceipt({
      hash,
      timeout: this.options.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
    });

    if (receipt.status !== 'success') {
      throw new Error(`${call.description} reverted in ${hash}`);
    }

    return hash;
  }
}
