/* eslint-disable no-console */
// Gera um PO Token (Proof of Origin) + visitor_data para uso no yt-dlp.
// O token gerado é vinculado ao visitor_data — funcional de qualquer IP,
// inclusive Render. Validade típica: semanas/meses.

const fs = require('fs');
const path = require('path');
const { BG } = require('bgutils-js');
const { Innertube } = require('youtubei.js');
const { JSDOM } = require('jsdom');

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

async function generate() {
  console.log('▶ Inicializando Innertube...');
  const innertube = await Innertube.create({
    retrieve_player: false,
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const visitorData = innertube.session.context.client.visitorData;
  if (!visitorData) throw new Error('Innertube não retornou visitor_data.');
  console.log('▶ visitor_data obtido (', visitorData.length, 'chars )');

  console.log('▶ Configurando JSDOM (sandbox para BotGuard VM)...');
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin
  });

  const bgConfig = {
    fetch: (input, init) => fetch(input, init),
    globalObj: globalThis,
    identifier: visitorData,
    requestKey: REQUEST_KEY
  };

  console.log('▶ Solicitando challenge ao BotGuard...');
  const bgChallenge = await BG.Challenge.create(bgConfig);
  if (!bgChallenge) throw new Error('Could not create BG Challenge.');

  const interpreterJavascript = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (interpreterJavascript) {
    // eslint-disable-next-line no-new-func
    new Function(interpreterJavascript)();
  } else {
    throw new Error('Could not load BG VM.');
  }

  console.log('▶ Resolvendo PO Token...');
  const poTokenResult = await BG.PoToken.generate({
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    bgConfig
  });

  if (!poTokenResult?.poToken) throw new Error('PO Token vazio.');

  console.log('\n✅ PO Token gerado.\n');
  console.log('   visitor_data length :', visitorData.length);
  console.log('   po_token length     :', poTokenResult.poToken.length);

  return {
    visitorData,
    poToken: poTokenResult.poToken
  };
}

function upsertEnvKey(envText, key, value) {
  const escapedValue = String(value);
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(envText)) {
    return envText.replace(re, `${key}=${escapedValue}`);
  }
  const sep = envText.endsWith('\n') ? '' : '\n';
  return `${envText}${sep}${key}=${escapedValue}\n`;
}

async function main() {
  const { visitorData, poToken } = await generate();

  const envPath = path.join(__dirname, '..', '.env');
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  let updated = original;
  updated = upsertEnvKey(updated, 'YOUTUBE_PO_TOKEN', poToken);
  updated = upsertEnvKey(updated, 'YOUTUBE_VISITOR_DATA', visitorData);

  fs.writeFileSync(envPath, updated, 'utf-8');
  console.log('\n📝 .env atualizado em', envPath);
  console.log('   - YOUTUBE_PO_TOKEN');
  console.log('   - YOUTUBE_VISITOR_DATA');
}

main().catch((err) => {
  console.error('\n❌ Falha ao gerar PO Token:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
