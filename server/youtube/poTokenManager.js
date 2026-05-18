// PO Token manager: gera/cacheia PO Token + visitor_data automaticamente
// via bgutils-js + youtubei.js + jsdom. Substitui a necessidade de rodar
// um bgutil-pot-server separado.
//
// Estratégia:
//  - Lazy: só gera quando alguém pede.
//  - Cache em memória, válido por TTL_MS (default 4h).
//  - Refresh forçado via invalidate() quando yt-dlp falha por SABR/auth.
//  - Fallback pros env vars se a geração falhar (mantém comportamento atual).

const { safeLog } = require('../utils/safeLog');

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const TTL_MS = Number(process.env.PO_TOKEN_TTL_MS || 4 * 60 * 60 * 1000); // 4h
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let cached = null; // { poToken, visitorData, generatedAt }
let inflight = null; // Promise compartilhada quando uma geração já está em curso

function readEnvPoToken() {
  return String(
    process.env.YOUTUBE_PO_TOKEN ||
    process.env.YT_PO_TOKEN ||
    process.env.YOUTUBE_POT ||
    ''
  ).trim();
}

function readEnvVisitorData() {
  return String(
    process.env.YOUTUBE_VISITOR_DATA ||
    process.env.YT_VISITOR_DATA ||
    ''
  ).trim();
}

function isRuntimeGenerationDisabled() {
  const raw = String(process.env.DISABLE_RUNTIME_PO_TOKEN || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

async function generateFresh() {
  // Imports dinâmicos pra evitar custo de boot se a feature nunca for usada.
  const { BG } = require('bgutils-js');
  const { Innertube } = require('youtubei.js');
  const { JSDOM } = require('jsdom');

  const innertube = await Innertube.create({
    retrieve_player: false,
    user_agent: USER_AGENT
  });

  const visitorData = innertube.session.context.client.visitorData;
  if (!visitorData) throw new Error('Innertube não retornou visitor_data.');

  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT
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

  const bgChallenge = await BG.Challenge.create(bgConfig);
  if (!bgChallenge) throw new Error('BG.Challenge.create retornou vazio.');

  const interpreter = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreter) throw new Error('BG VM ausente.');

  // eslint-disable-next-line no-new-func
  new Function(interpreter)();

  const result = await BG.PoToken.generate({
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    bgConfig
  });

  if (!result?.poToken) throw new Error('PO Token vazio.');

  return {
    poToken: result.poToken,
    visitorData,
    generatedAt: Date.now()
  };
}

async function getCurrentPoToken({ force = false } = {}) {
  // 1) Env tem prioridade quando runtime desligado
  if (isRuntimeGenerationDisabled()) {
    const envPo = readEnvPoToken();
    const envVd = readEnvVisitorData();
    if (envPo && envVd) {
      return { poToken: envPo, visitorData: envVd, source: 'env' };
    }
    return null;
  }

  // 2) Cache vivo e ainda fresco
  if (!force && cached && Date.now() - cached.generatedAt < TTL_MS) {
    return { ...cached, source: 'cache' };
  }

  // 3) Geração já em curso — todos esperam o mesmo Promise
  if (inflight) {
    try {
      const value = await inflight;
      return { ...value, source: 'inflight' };
    } catch (_) {
      // se falhou, continua e tenta env
    }
  }

  // 4) Gera nova
  inflight = (async () => {
    try {
      const fresh = await generateFresh();
      cached = fresh;
      safeLog.info('[YouTube][pot] PO Token gerado', {
        poTokenLen: fresh.poToken.length,
        visitorDataLen: fresh.visitorData.length,
        ttlHours: (TTL_MS / 3600000).toFixed(1)
      });
      return fresh;
    } finally {
      inflight = null;
    }
  })();

  try {
    const value = await inflight;
    return { ...value, source: 'fresh' };
  } catch (genErr) {
    safeLog.warn('[YouTube][pot] Falha ao gerar PO Token em runtime, caindo pro env.', {
      message: String(genErr?.message || genErr).slice(0, 200)
    });

    const envPo = readEnvPoToken();
    const envVd = readEnvVisitorData();
    if (envPo && envVd) {
      return { poToken: envPo, visitorData: envVd, source: 'env-fallback' };
    }
    return null;
  }
}

function invalidate() {
  if (cached) {
    safeLog.info('[YouTube][pot] Cache de PO Token invalidado');
  }
  cached = null;
}

function getStatus() {
  return {
    hasCached: Boolean(cached),
    ageMs: cached ? Date.now() - cached.generatedAt : null,
    ttlMs: TTL_MS,
    runtimeDisabled: isRuntimeGenerationDisabled(),
    hasEnvFallback: Boolean(readEnvPoToken() && readEnvVisitorData())
  };
}

module.exports = {
  getCurrentPoToken,
  invalidate,
  getStatus,
  _private: {
    generateFresh,
    readEnvPoToken,
    readEnvVisitorData
  }
};
