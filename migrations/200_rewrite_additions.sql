-- docs/data-spec.md §5.2 (additive changes) and §6.2 (new guarantees), verbatim and in order. Applied after the
-- bootstrap and the nine frozen migrations (ADR-019).

-- §5.2
create table public.slot_tags (
  campaign_address public.eth_address not null,
  slot_id integer not null,
  code text not null unique check (code ~ '^TC-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$'),
  issued_at timestamptz not null default now(),
  primary key (campaign_address, slot_id),
  foreign key (campaign_address, slot_id) references public.slots (campaign_address, slot_id) on delete cascade
);
alter table public.slot_tags enable row level security;
revoke all on public.slot_tags from anon, authenticated;

alter table public.audit_sessions add column report_notes jsonb;

alter table public.carbon_batches add column issued_at timestamptz;

alter table public.submissions add column precheck_results jsonb
  check (precheck_results is null or jsonb_typeof(precheck_results) = 'array');

create index flags_tree_idx on public.flags (tree_id, created_at);
create index challenges_tree_idx on public.challenges (tree_id, created_at desc);
create index carbon_batches_newest_idx on public.carbon_batches (issued_block desc);

-- §6.2
create unique index submissions_one_live_check_in_idx on public.submissions (tree_id, milestone)
  where kind = 'ALIVE'
    and status in ('uploaded', 'checking', 'scored', 'passed', 'needs_review', 'attested', 'onchain');
create unique index submissions_one_live_planting_idx on public.submissions (campaign_address, slot_id)
  where kind = 'PLANTED'
    and status in ('uploaded', 'checking', 'scored', 'passed', 'needs_review', 'attested', 'onchain');
create unique index submissions_one_inflight_event_idx on public.submissions (tree_id, kind)
  where kind in ('DEAD', 'REPLANTED')
    and status in ('uploaded', 'checking', 'scored', 'passed', 'needs_review', 'attested');

create extension if not exists btree_gist;
alter table public.challenges add constraint challenges_expiry_after_issue check (expires_at > created_at);
alter table public.challenges add constraint challenges_one_open_per_tree
  exclude using gist (tree_id with =, tstzrange(created_at, expires_at, '[)') with &&)
  where (fulfilled_submission_id is null);

alter table public.audit_sessions add constraint audit_sessions_closed_have_notes
  check (status <> 'closed' or (report_notes is not null and report ? 'notesHash')) not valid;

create function public.guard_closed_audit_session() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'closed' then
    raise exception 'session_closed' using errcode = 'check_violation';
  end if;
  return new;
end; $$;
create trigger audit_sessions_frozen_after_close before update on public.audit_sessions
  for each row execute function public.guard_closed_audit_session();

create function public.guard_closed_audit_sample() returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.audit_sessions s where s.id = new.session_id and s.status = 'closed') then
    raise exception 'session_closed' using errcode = 'check_violation';
  end if;
  return new;
end; $$;
create trigger audit_samples_frozen_after_close before insert or update on public.audit_samples
  for each row execute function public.guard_closed_audit_sample();

create unique index flags_one_pending_per_flagger_idx on public.flags (tree_id, flagger_profile_id, reason_hash)
  where status = 'pending';

alter table public.devices add constraint devices_label_required check (label is not null) not valid;
