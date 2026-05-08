-- Tabela de logs de conversão
create table if not exists public.conversoes (
  id bigserial primary key,
  nome_arquivo text not null,
  storage_path text,
  criado_em timestamptz not null default now()
);

-- Index para consulta das últimas conversões
create index if not exists conversoes_criado_em_idx
  on public.conversoes (criado_em desc);

-- Segurança
alter table public.conversoes enable row level security;

-- Como o frontend grava via API backend com service_role,
-- não é necessário abrir política para anon/authenticated.
-- Se quiser leitura direta do frontend, crie política explícita:
-- create policy "Leitura pública das conversões"
-- on public.conversoes
-- for select
-- to anon, authenticated
-- using (true);

-- Bucket para armazenar mp3 convertidos
insert into storage.buckets (id, name, public)
values ('converted-audio', 'converted-audio', false)
on conflict (id) do nothing;

-- Políticas do bucket (somente backend com service_role bypassa RLS).
-- Se você optar por upload direto do frontend, descomente as políticas abaixo:
-- create policy "Permite upload autenticado"
-- on storage.objects
-- for insert to authenticated
-- with check (bucket_id = 'converted-audio');
