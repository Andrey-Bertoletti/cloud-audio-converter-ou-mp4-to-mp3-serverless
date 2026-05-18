process.env.YTDL_NO_UPDATE = process.env.YTDL_NO_UPDATE || '1';
require('dotenv').config();

const cron = require('node-cron');
const { createApp } = require('./app');
const { supabaseAdmin } = require('./config/supabaseAdmin');
const { safeLog } = require('./utils/safeLog');
const {
  checkYtDlpAndFfmpegAvailability,
  getExternalToolDiagnostics,
  resolveYtDlpPath,
  maskPath
} = require('./youtube/ytDlpFallback');
const poTokenManager = require('./youtube/poTokenManager');

const app = createApp();

function getYtDlpFallbackConfig() {
  const raw = String(process.env.ENABLE_YTDLP_FALLBACK ?? '')
    .trim()
    .toLowerCase();

  if (!raw) return { enabled: true, required: false };

  if (['0', 'false', 'no', 'off'].includes(raw)) return { enabled: false, required: false };
  if (['required', 'strict', 'force', 'mandatory'].includes(raw)) return { enabled: true, required: true };
  if (['1', 'true', 'yes', 'on'].includes(raw)) return { enabled: true, required: false };

  return { enabled: true, required: false };
}

// Hostnames conhecidos de fornecedores DATACENTER (não vão furar o anti-bot do YouTube).
// Aceita o nome simples (oxylabs, brightdata) ou padrões específicos (dc.oxylabs.io).
const DATACENTER_PROXY_PATTERNS = [
  /^dc\./i,
  /^datacenter\./i,
  /shared-datacenter/i,
  /\bdc-proxy\b/i,
  /pq\.oxylabs\.io/i // Oxylabs Datacenter shared pool
];

const RESIDENTIAL_PROXY_PATTERNS = [
  /^pr\./i,
  /^residential\./i,
  /\bisp\b/i,
  /-residential/i
];

function classifyProxyUrl(rawUrl) {
  if (!rawUrl) return { configured: false };
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const isDc = DATACENTER_PROXY_PATTERNS.some((re) => re.test(host));
    const isRes = RESIDENTIAL_PROXY_PATTERNS.some((re) => re.test(host));
    return {
      configured: true,
      host,
      isDatacenter: isDc,
      isResidential: isRes,
      kind: isDc ? 'datacenter' : isRes ? 'residential' : 'unknown'
    };
  } catch (_) {
    return { configured: true, host: 'invalid-url' };
  }
}

function logProxyHealth() {
  const proxyUrl = process.env.YOUTUBE_PROXY_URL || process.env.YOUTUBE_PROXY_URI || '';
  const info = classifyProxyUrl(proxyUrl);

  if (!info.configured) {
    safeLog('warn', '[Backend] Nenhum YOUTUBE_PROXY_URL configurado. Em IPs datacenter (Render/AWS) o YouTube quase sempre bloqueia.');
    return info;
  }

  if (info.isDatacenter) {
    safeLog.error('[Backend] ⚠️  PROXY DATACENTER DETECTADO: ' + info.host);
    safeLog.error('[Backend]    Proxies datacenter são bloqueados pelo YouTube com "Sign in to confirm you\'re not a bot".');
    safeLog.error('[Backend]    SOLUÇÃO: troque pro endpoint RESIDENCIAL do mesmo provedor.');
    safeLog.error('[Backend]    Oxylabs: dc.oxylabs.io → pr.oxylabs.io:7777  (planos diferentes)');
    safeLog.error('[Backend]    Webshare: usar plano residential (não datacenter).');
    return info;
  }

  if (info.isResidential) {
    safeLog('log', '[Backend] Proxy residencial detectado: ' + info.host + ' (✓ compatível com YouTube)');
  } else {
    safeLog('log', '[Backend] Proxy configurado: ' + info.host + ' (tipo: ' + info.kind + ')');
  }
  return info;
}

async function logMediaToolingHealth() {
  const status = await checkYtDlpAndFfmpegAvailability();
  const fallbackCfg = getYtDlpFallbackConfig();
  const diagnostics = await getExternalToolDiagnostics();

  safeLog.info('[Backend] Ferramentas externas', diagnostics);
  logProxyHealth();

  if (status.ok) {
    safeLog('log', `[Backend] yt-dlp disponível: ${status.ytDlpVersion}`);
    safeLog('log', `[Backend] ffmpeg disponível: ${status.ffmpegVersion}`);
    return { status, fallbackCfg, shouldAbortStartup: false };
  }

  const meta = {
    ytDlpPath: maskPath(resolveYtDlpPath()),
    ytDlpAvailable: Boolean(status.ytDlpVersion),
    ytDlpVersion: status.ytDlpVersion || null,
    ffmpegAvailable: Boolean(status.ffmpegVersion),
    ffmpegVersion: status.ffmpegVersion || null
  };

  if (fallbackCfg.enabled && !status.ytDlpVersion) {
    safeLog.error(
      '[Backend] ENABLE_YTDLP_FALLBACK=true, mas yt-dlp não foi encontrado. Corrija YTDLP_PATH ou instale yt-dlp.',
      meta
    );
    process.exit(1);
  }

  safeLog('warn', '[Backend] yt-dlp/ffmpeg não estão disponíveis. O fallback pode falhar.', meta);
  return { status, fallbackCfg, shouldAbortStartup: false };
}

async function performCleanup() {
  safeLog('log', '[Cleanup] Iniciando limpeza de arquivos com mais de 24 horas...');
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: expired, error: fetchError } = await supabaseAdmin
      .from('conversoes')
      .select('id, storage_path')
      .lt('criado_em', yesterday);

    if (fetchError) throw fetchError;
    if (!expired || expired.length === 0) {
      safeLog('log', '[Cleanup] Nenhum arquivo expirado para remover.');
      return;
    }

    safeLog('log', `[Cleanup] Encontrados ${expired.length} registros para remover.`);

    const pathsToRemove = expired
      .filter((row) => row.storage_path)
      .map((row) => row.storage_path);

    if (pathsToRemove.length > 0) {
      const { error: storageError } = await supabaseAdmin.storage.from('converted-audio').remove(pathsToRemove);
      if (storageError) safeLog('error', '[Cleanup] Erro ao remover do storage:', storageError);
      else safeLog('log', `[Cleanup] ${pathsToRemove.length} arquivos removidos do Storage.`);
    }

    const idsToRemove = expired.map((row) => row.id);
    const { error: dbError } = await supabaseAdmin.from('conversoes').delete().in('id', idsToRemove);

    if (dbError) throw dbError;
    safeLog('log', '[Cleanup] Registros removidos do banco de dados com sucesso.');
  } catch (err) {
    safeLog('error', '[Cleanup] Falha na limpeza:', err);
  }
}

if (process.env.DISABLE_CLEANUP_CRON !== '1') {
  cron.schedule('0 * * * *', performCleanup);
}

// Warmup do PO Token logo após o boot (não bloqueia o listen) e refresh a cada 3h.
async function warmupPoToken() {
  try {
    const result = await poTokenManager.getCurrentPoToken();
    if (result) {
      safeLog('log', '[Backend][pot] Warmup OK', {
        source: result.source,
        poTokenLen: result.poToken.length
      });
    } else {
      safeLog('warn', '[Backend][pot] Warmup não retornou token (runtime desligado e env vazio).');
    }
  } catch (err) {
    safeLog('warn', '[Backend][pot] Warmup falhou (seguindo sem token):', {
      message: String(err?.message || err).slice(0, 200)
    });
  }
}

if (process.env.DISABLE_POT_REFRESH_CRON !== '1') {
  cron.schedule('15 */3 * * *', () => {
    poTokenManager.invalidate();
    warmupPoToken();
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);

  (async () => {
    await logMediaToolingHealth();

    app.listen(port, () => {
      const mode = process.env.NODE_ENV === 'production' ? 'PRODUÇÃO (Nuvem)' : 'DESENVOLVIMENTO (Local)';
      safeLog('log', `[Backend] Rodando em modo: ${mode}`);
      safeLog('log', `[Backend] API disponível na porta: ${port}`);
      // Warmup async (não bloqueia)
      warmupPoToken();
    });
  })().catch((err) => {
    safeLog('error', '[Backend] Falha no startup.', {
      name: err?.name,
      code: err?.code,
      message: err?.message
    });
    process.exit(1);
  });
}

module.exports = { app, performCleanup, logMediaToolingHealth, getYtDlpFallbackConfig };
