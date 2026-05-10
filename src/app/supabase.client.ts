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
      // Função de Lock simplificada para evitar bloqueios de navegador
      lock: async (name: string, acquireTimeout: number, fn: () => Promise<any>) => {
        return await fn();
      }
    }
  }
);
