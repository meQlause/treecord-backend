-- Testnet faucet: a wallet first stored on a profile gets gas and test USDC once, sent by the operator lane.
alter type public.relayer_job_kind add value 'faucet_eth';
alter type public.relayer_job_kind add value 'faucet_usdc';
