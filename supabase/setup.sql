-- Tabela de logs de conversão
create table if not exists public.conversoes (
  id bigserial primary key,
  nome_arquivo text not null,
  storage_path text,
  user_id uuid references auth.users(id),
  criado_em timestamptz not null default now()
);

-- Index para consulta das últimas conversões
create index if not exists conversoes_criado_em_idx
  on public.conversoes (criado_em desc);

-- Segurança
alter table public.conversoes enable row level security;

-- Políticas para a tabela
create policy "Usuários podem ver suas próprias conversões"
on public.conversoes
for select
to authenticated
using (auth.uid() = user_id);

create policy "Usuários podem inserir suas próprias conversões"
on public.conversoes
for insert
to authenticated
with check (auth.uid() = user_id);

-- Bucket para armazenar mp3 convertidos
insert into storage.buckets (id, name, public)
values ('converted-audio', 'converted-audio', false)
on conflict (id) do nothing;

-- Políticas do bucket
create policy "Permite upload em pasta própria"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'converted-audio' AND 
  (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Permite leitura de arquivos próprios"
on storage.objects
for select to authenticated
using (
  bucket_id = 'converted-audio' AND 
  (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Permite excluir arquivos próprios"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'converted-audio' AND 
  (storage.foldername(name))[1] = auth.uid()::text
);
