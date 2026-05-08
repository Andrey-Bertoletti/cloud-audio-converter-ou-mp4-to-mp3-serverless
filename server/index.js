require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { supabaseAdmin } = require('./config/supabaseAdmin');
const authMiddleware = require('./middleware/auth');

const app = express();
const port = Number(process.env.PORT || 3000);

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

// Configuração de Segurança
app.use(helmet()); // Adiciona headers de segurança (HSTS, CSP, etc)

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
  const user_id = req.user.id;
  
  const { data, error } = await supabaseAdmin
    .from('conversoes')
    .select('id, nome_arquivo, criado_em')
    .eq('user_id', user_id)
    .order('criado_em', { ascending: false })
    .limit(5);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json(data ?? []);
});

app.listen(port, () => {
  console.log(`API protegida disponível em http://localhost:${port}`);
});
