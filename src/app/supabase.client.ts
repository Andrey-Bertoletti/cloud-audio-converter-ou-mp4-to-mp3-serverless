import { createClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment';

export const supabase = createClient(
  environment.supabaseUrl,
  environment.supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Desativar o LockManager para evitar erros de permissão no navegador
      storageKey: 'sb-auth-token',
      lock: {
        acquire: async () => ({ error: null }),
        release: async () => {}
      } as any
    }
  }
);
