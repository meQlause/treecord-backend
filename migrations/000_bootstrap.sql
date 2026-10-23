-- ADR-019 compatibility bootstrap. The nine frozen migrations were written for Supabase: they grant to its three
-- roles and insert two rows into storage.buckets. This file creates exactly those, inert, so the frozen files apply
-- byte-identical on plain PostgreSQL. It must never grow real objects: MinIO (ADR-020) holds the real buckets.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
