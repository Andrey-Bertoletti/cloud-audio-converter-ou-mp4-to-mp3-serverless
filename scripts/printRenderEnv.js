/* eslint-disable no-console */
// Imprime as env vars que precisam estar no Render — formato copy-paste
// (uma KEY=VALUE por linha) ou bullet humano. Não imprime segredos do Supabase.
//
// Uso:
//   node scripts/printRenderEnv.js          (humano)
//   node scripts/printRenderEnv.js --raw    (formato Render bulk-edit)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const RAW = process.argv.includes('--raw');

const VARS = [
  {
    key: 'YOUTUBE_PO_TOKEN',
    value: process.env.YOUTUBE_PO_TOKEN || '',
    required: true,
    note: 'Gerado por scripts/generatePoToken.js — válido semanas/meses.'
  },
  {
    key: 'YOUTUBE_VISITOR_DATA',
    value: process.env.YOUTUBE_VISITOR_DATA || '',
    required: true,
    note: 'Vinculado ao PO Token acima — sempre par.'
  },
  {
    key: 'YOUTUBE_PROXY_URL',
    value: process.env.YOUTUBE_PROXY_URL || process.env.YOUTUBE_PROXY_URI || '',
    required: true,
    warnIf: (v) => /^https?:\/\/[^@]*@dc\./i.test(v) && '⚠️  Proxy DATACENTER detectado — YouTube bloqueia. Troque pro residencial.'
  },
  {
    key: 'YOUTUBE_COOKIE',
    value: process.env.YOUTUBE_COOKIE || '',
    required: false,
    redactInOutput: true,
    note: 'Cole o JSON exportado do navegador (logado). Renove a cada ~30 dias.'
  },
  {
    key: 'ENABLE_YTDLP_FALLBACK',
    value: process.env.ENABLE_YTDLP_FALLBACK || 'true',
    required: true
  },
  {
    key: 'YTDLP_PATH',
    value: process.env.YTDLP_PATH || '/opt/render/project/src/.bin/yt-dlp',
    required: true
  },
  {
    key: 'NODE_ENV',
    value: 'production',
    required: true
  }
];

function truncate(value, max = 24) {
  if (!value) return '';
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + '...';
}

function rawOutput() {
  // formato pra colar no Render → Environment → Bulk Edit
  for (const v of VARS) {
    if (!v.value) continue;
    // valores multi-linha (cookie JSON) precisam escapar quebras de linha
    const flat = v.value.replace(/\r?\n/g, '\\n');
    console.log(`${v.key}=${flat}`);
  }
}

function humanOutput() {
  console.log('\n┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│ ENV VARS PARA O RENDER — copie do .env local e cole no painel              │');
  console.log('│ Dashboard → Service → Environment → Add Environment Variable               │');
  console.log('└─────────────────────────────────────────────────────────────────────────────┘\n');

  let missing = 0;
  for (const v of VARS) {
    const present = Boolean(v.value);
    const flag = present ? '✓' : v.required ? '✗' : '○';
    const len = v.value ? `(${v.value.length} chars)` : '';
    const preview = v.redactInOutput && v.value ? '<redigido>' : truncate(v.value, 40);

    console.log(`  [${flag}] ${v.key.padEnd(24)} ${len.padEnd(14)} ${preview}`);

    if (v.warnIf) {
      const msg = v.warnIf(v.value);
      if (msg) console.log(`        ${msg}`);
    }
    if (!present && v.required) missing += 1;
    if (v.note) console.log(`        ↳ ${v.note}`);
  }

  if (missing) {
    console.log(`\n⚠️  Faltam ${missing} variável(is) requerida(s). Rode scripts/generatePoToken.js se for PO Token/visitor.`);
  }

  console.log('\n──────────────────────────────────────────────────────────────────────────────');
  console.log('Build command no Render:');
  console.log('  npm install && npm run build && mkdir -p .bin && \\');
  console.log('  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \\');
  console.log('       -o .bin/yt-dlp && chmod +x .bin/yt-dlp');
  console.log('\nStart command:');
  console.log('  node server/index.js');
  console.log('\nPara colar tudo em Bulk Edit, rode:');
  console.log('  node scripts/printRenderEnv.js --raw');
  console.log('──────────────────────────────────────────────────────────────────────────────\n');
}

if (RAW) rawOutput();
else humanOutput();
