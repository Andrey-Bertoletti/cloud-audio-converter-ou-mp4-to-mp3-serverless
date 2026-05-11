require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { supabaseAdmin } = require('./config/supabaseAdmin');
const authMiddleware = require('./middleware/auth');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
const os = require('os');

function safeFileName(input) {
  const baseName = String(input || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  const clipped = baseName.slice(0, 80);
  return clipped || `audio-${Date.now()}`;
}

// Configura o caminho do ffmpeg estático
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = Number(process.env.PORT || 3000);

// Confia no proxy do Render (corrige ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
app.set('trust proxy', 1);

// Função de Limpeza Automática (24 horas)
async function performCleanup() {
  console.log('[Cleanup] Iniciando limpeza de arquivos com mais de 24 horas...');
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 1. Buscar registros expirados
    const { data: expired, error: fetchError } = await supabaseAdmin
      .from('conversoes')
      .select('id, storage_path')
      .lt('criado_em', yesterday);

    if (fetchError) throw fetchError;
    if (!expired || expired.length === 0) {
      console.log('[Cleanup] Nenhum arquivo expirado para remover.');
      return;
    }

    console.log(`[Cleanup] Encontrados ${expired.length} registros para remover.`);

    // 2. Remover do Storage
    const pathsToRemove = expired
      .filter(row => row.storage_path)
      .map(row => row.storage_path);

    if (pathsToRemove.length > 0) {
      const { error: storageError } = await supabaseAdmin.storage
        .from('converted-audio')
        .remove(pathsToRemove);
      
      if (storageError) console.error('[Cleanup] Erro ao remover do storage:', storageError.message);
      else console.log(`[Cleanup] ${pathsToRemove.length} arquivos removidos do Storage.`);
    }

    // 3. Remover do Banco de Dados
    const idsToRemove = expired.map(row => row.id);
    const { error: dbError } = await supabaseAdmin
      .from('conversoes')
      .delete()
      .in('id', idsToRemove);

    if (dbError) throw dbError;
    console.log('[Cleanup] Registros removidos do banco de dados com sucesso.');
  } catch (err) {
    console.error('[Cleanup] Falha na limpeza:', err.message);
  }
}

// Agenda a limpeza para rodar a cada 1 hora
cron.schedule('0 * * * *', performCleanup);

// Configuração de Segurança Avançada para FFmpeg (COOP/COEP)
app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginEmbedderPolicy: { policy: "require-corp" },
}));

// Rate Limiting: Máximo de 100 requisições por 15 minutos por IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Muitas requisições deste IP, tente novamente em 15 minutos.' }
});
app.use(limiter);

// CORS restrito (em produção deve ser o domínio do frontend)
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:4200',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/health', (_, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Todas as rotas de API agora exigem autenticação via JWT do Supabase
app.use('/api', authMiddleware);

app.post('/api/conversoes', async (req, res) => {
  try {
    const { nomeArquivo, storagePath } = req.body;
    const user_id = req.user.id; // Usuário identificado pelo middleware

    if (!nomeArquivo) {
      return res.status(400).json({ error: 'nomeArquivo é obrigatório.' });
    }

    const { error } = await supabaseAdmin.from('conversoes').insert({
      nome_arquivo: nomeArquivo,
      storage_path: storagePath ?? null,
      user_id: user_id
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Erro inesperado.'
    });
  }
});

app.get('/api/conversoes', async (req, res) => {
  try {
    const user_id = req.user.id;
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit ?? '5'), 10) || 5));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabaseAdmin
      .from('conversoes')
      .select('id, nome_arquivo, criado_em, storage_path', { count: 'exact' })
      .eq('user_id', user_id)
      .order('criado_em', { ascending: false })
      .range(from, to);

    if (error) throw error;

    return res.status(200).json({
      data: data ?? [],
      total: count ?? 0,
      page,
      totalPages: Math.max(1, Math.ceil((count ?? 0) / limit))
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Erro interno ao carregar conversões.' });
  }
});

app.post('/api/youtube/convert', async (req, res) => {
  let tempFilePath = '';
  try {
    const { youtubeUrl } = req.body;
    const user_id = req.user.id;

    if (!ytdl.validateURL(youtubeUrl)) {
      return res.status(400).json({ error: 'URL do YouTube inválida.' });
    }

    console.log(`[YouTube] Iniciando conversão para o usuário ${user_id}: ${youtubeUrl}`);

    // 1. Configurar Agente camuflado como YouTube TV
    let agent;
    if (process.env.YOUTUBE_COOKIE) {
      try {
        const cookies = JSON.parse(process.env.YOUTUBE_COOKIE);
        agent = ytdl.createAgent(cookies);
      } catch (e) {
        console.error('[YouTube] Erro nos cookies:', e.message);
      }
    }

    const options = { 
      agent,
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
          'X-Youtube-Client-Name': '5', // 5 é o ID para TV
          'X-Youtube-Client-Version': '2.20230922.00.00'
        }
      }
    };

    const info = await ytdl.getInfo(youtubeUrl, options);
    const fileName = `${safeFileName(info?.videoDetails?.title)}.mp3`;
    const timestamp = Date.now();
    console.log(`[YouTube] Título: ${info?.videoDetails?.title || 'N/A'}`);
    const storagePath = `${user_id}/yt-${timestamp}-${fileName}`;

    // 2. Criar caminho temporário para o arquivo convertido
    tempFilePath = path.join(os.tmpdir(), `convert-${timestamp}.mp3`);

    // 3. Baixar e converter usando stream
    await new Promise((resolve, reject) => {
      const streamOptions = { 
        quality: 'highestaudio', 
        filter: 'audioonly',
        agent: agent,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'X-Youtube-Client-Name': '5',
            'X-Youtube-Client-Version': '2.20230922.00.00'
          }
        }
      };

      const stream = ytdl(youtubeUrl, streamOptions);

      ffmpeg(stream)
        .toFormat('mp3')
        .audioBitrate(192)
        .on('error', (err) => {
          console.error('[YouTube] Erro no FFmpeg:', err);
          reject(err);
        })
        .on('end', () => {
          console.log('[YouTube] Conversão local concluída.');
          resolve(true);
        })
        .save(tempFilePath);
    });

    // 4. Ler o arquivo convertido e fazer upload para o Supabase
    const fileBuffer = await fs.promises.readFile(tempFilePath);
    const { error: uploadError } = await supabaseAdmin.storage
      .from('converted-audio')
      .upload(storagePath, fileBuffer, {
        contentType: 'audio/mpeg',
        upsert: false
      });

    if (uploadError) throw uploadError;

    // 5. Salvar no banco de dados
    const { error: dbError } = await supabaseAdmin.from('conversoes').insert({
      nome_arquivo: fileName,
      storage_path: storagePath,
      user_id: user_id
    });

    if (dbError) throw dbError;

    // 6. Gerar URL pública (ou assinada)
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('converted-audio')
      .getPublicUrl(storagePath);

    console.log('[YouTube] Sucesso total!');
    return res.status(200).json({ 
      ok: true, 
      downloadUrl: publicUrl,
      fileName: fileName
    });

  } catch (error) {
    console.error('[YouTube] Erro Interno:', error);
    return res.status(500).json({ 
      error: 'Erro no servidor durante a conversão',
      details: error?.message || 'Falha inesperada.',
      code: error?.code
    });
  } finally {
    // Limpar arquivo temporário
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        await fs.promises.unlink(tempFilePath);
      } catch (cleanupError) {
        console.error('[YouTube] Erro ao limpar arquivo temporário:', cleanupError?.message || cleanupError);
      }
    }
  }
});

app.listen(port, () => {
  const mode = process.env.NODE_ENV === 'production' ? 'PRODUÇÃO (Nuvem)' : 'DESENVOLVIMENTO (Local)';
  console.log(`[Backend] Rodando em modo: ${mode}`);
  console.log(`[Backend] API disponível na porta: ${port}`);
});
