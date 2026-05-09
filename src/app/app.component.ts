import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { supabase } from './supabase.client';
import { environment } from '../environments/environment';
import { User } from '@supabase/supabase-js';

type Conversao = {
  id: number;
  nome_arquivo: string;
  criado_em: string;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit {
  // Auth state
  user: User | null = null;
  email = '';
  password = '';
  confirmPassword = '';
  name = '';
  youtubeUrl = '';
  isAuthLoading = true;
  authMode: 'login' | 'signup' = 'login';
  newPassword = '';
  currentPassword = '';
  
  // Tab State
  currentTab: 'local' | 'youtube' = 'local';
  
  // Converting state
  isYtConverting = false;
  ytStatus = '';
  isConverting = false;
  isSavingProfile = false;
  isUpdatingPassword = false;
  isAuthActionLoading = false;
  progress = 0;
  toasts: { message: string, type: 'success' | 'error', id: number }[] = [];
  isDarkMode = true;

  // View state
  currentView: 'converter' | 'profile' | 'reset-password' = 'converter';
  
  // Pagination state
  currentPage = 1;
  totalPages = 1;
  pageSize = 5;

  selectedFile: File | null = null;
  isDragging = false;
  errorMessage = '';
  successMessage = '';
  outputUrl: string | null = null;
  outputName = '';
  conversoes: Conversao[] = [];

  private ffmpeg = new FFmpeg();
  private ffmpegLoaded = false;

  constructor(public cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    const hash = window.location.hash;
    if (hash && hash.includes('type=recovery')) {
      this.currentView = 'reset-password';
    }

    const { data: { session } } = await supabase.auth.getSession();
    this.user = session?.user ?? null;
    this.isAuthLoading = false;

    if (this.user) {
      await this.carregarConversoes();
      this.inicializarFfmpeg(); 
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      this.user = session?.user ?? null;
      
      if (event === 'PASSWORD_RECOVERY') {
        this.currentView = 'reset-password';
      }

      if (this.user) {
        await this.carregarConversoes();
        this.inicializarFfmpeg();
      } else {
        this.conversoes = [];
        this.currentView = 'converter';
      }
      this.cdr.markForCheck();
    });
  }

  async signIn(): Promise<void> {
    try {
      this.isAuthActionLoading = true;
      this.cdr.markForCheck();
      const { error } = await supabase.auth.signInWithPassword({
        email: this.email,
        password: this.password
      });
      if (error) throw error;
    } catch (error: any) {
      this.showToast(error.message, 'error');
    } finally {
      this.isAuthActionLoading = false;
      this.cdr.markForCheck();
    }
  }

  async signInWithGoogle(): Promise<void> {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}`
      }
    });
    if (error) {
      this.errorMessage = error.message;
      this.cdr.markForCheck();
    }
  }

  async signUp(): Promise<void> {
    this.errorMessage = '';
    if (this.password !== this.confirmPassword) {
      this.errorMessage = 'As senhas não coincidem.';
      return;
    }
    if (!this.name) {
      this.errorMessage = 'O nome é obrigatório.';
      return;
    }

    const { error } = await supabase.auth.signUp({
      email: this.email,
      password: this.password,
      options: { data: { display_name: this.name } }
    });

    if (error) this.errorMessage = error.message;
    else this.successMessage = 'Confirme seu e-mail para continuar.';
    this.cdr.markForCheck();
  }

  get userDisplayName(): string {
    return this.user?.user_metadata?.['display_name'] || this.user?.email || 'Usuário';
  }

  async updateProfile(): Promise<void> {
    this.errorMessage = '';
    this.successMessage = '';
    if (!this.name) {
      this.errorMessage = 'O nome não pode estar vazio.';
      return;
    }

    try {
      this.isSavingProfile = true;
      this.cdr.markForCheck();

      const { error } = await supabase.auth.updateUser({
        data: { display_name: this.name }
      });

      if (error) throw error;
      this.showToast('Perfil atualizado com sucesso!', 'success');
    } catch (error: any) {
      this.showToast(error.message || 'Erro ao atualizar perfil', 'error');
    } finally {
      this.isSavingProfile = false;
      this.cdr.markForCheck();
    }
  }

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
    this.cdr.markForCheck();
  }

  toggleAuthMode(): void {
    this.authMode = this.authMode === 'login' ? 'signup' : 'login';
    this.errorMessage = '';
    this.successMessage = '';
    this.cdr.markForCheck();
  }

  async updatePassword(): Promise<void> {
    if (!this.newPassword || this.newPassword.length < 6) {
      this.errorMessage = 'A nova senha deve ter pelo menos 6 caracteres.';
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    if (this.currentView === 'profile') {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: this.user?.email || '',
        password: this.currentPassword
      });
      if (signInError) {
        this.errorMessage = 'Senha atual incorreta.';
        return;
      }
    }

    try {
      this.isUpdatingPassword = true;
      this.cdr.markForCheck();

      const userEmail = this.user?.email || '';
      const changeDate = new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'long',
        timeStyle: 'short'
      }).format(new Date());

      // Atualiza a senha de fato
      const { error } = await supabase.auth.updateUser({ password: this.newPassword });
      
      if (error) throw error;

      // Chama o backend para enviar o e-mail de confirmação (DADOS DINÂMICOS)
      this.enviarEmailConfirmacao(userEmail, changeDate);

      this.showToast('Senha alterada com sucesso! Um e-mail de confirmação foi enviado.', 'success');
      this.newPassword = '';
      this.currentPassword = '';
      if (this.currentView === 'reset-password') {
        this.currentView = 'converter';
      }
    } catch (error: any) {
      this.showToast(error.message, 'error');
    } finally {
      this.isUpdatingPassword = false;
      this.cdr.markForCheck();
    }
  }

  private async enviarEmailConfirmacao(email: string, data: string): Promise<void> {
    try {
      // Aqui chamaremos sua Edge Function ou API Node.js
      await fetch(`${environment.apiBaseUrl}/api/notify-security`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, data, type: 'password_change' })
      });
    } catch (e) {
      console.error('Erro ao enviar e-mail de segurança:', e);
    }
  }

  showToast(message: string, type: 'success' | 'error' = 'success'): void {
    const id = Date.now();
    this.toasts.push({ message, type, id });
    this.cdr.markForCheck();

    setTimeout(() => {
      this.toasts = this.toasts.filter(t => t.id !== id);
      this.cdr.markForCheck();
    }, 4000);
  }

  trackByToast(index: number, toast: any): number {
    return toast.id;
  }

  toggleTheme(): void {
    this.isDarkMode = !this.isDarkMode;
    if (this.isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    this.cdr.markForCheck();
  }

  async forgotPassword(): Promise<void> {
    if (!this.email) {
      this.showToast('Por favor, preencha o campo de e-mail primeiro.', 'error');
      return;
    }

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(this.email, {
        redirectTo: `${window.location.origin}/?view=reset-password`
      });

      if (error) throw error;
      this.showToast('Link de recuperação enviado para seu e-mail!', 'success');
    } catch (error: any) {
      this.showToast(error.message || 'Erro ao enviar recuperação', 'error');
    }
    this.cdr.markForCheck();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = false;
    const file = event.dataTransfer?.files?.[0];
    this.aplicarArquivo(file);
  }

  onFileInputChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    this.aplicarArquivo(file);
  }

  async converterArquivo(): Promise<void> {
    if (!this.selectedFile || this.isConverting) return;

    let watchdog: any;
    try {
      this.isConverting = true;
      this.progress = 0;
      this.cdr.markForCheck();

      // Watchdog: Se em 30 segundos não terminar, libera o botão
      watchdog = setTimeout(() => {
        if (this.isConverting) {
          this.isConverting = false;
          this.showToast('Conversão demorou demais. Tente novamente.', 'error');
          this.cdr.markForCheck();
        }
      }, 45000);

      await this.inicializarFfmpeg();
      
      this.ffmpeg.on('progress', ({ progress }) => {
        this.progress = Math.round(progress * 100);
        this.cdr.markForCheck();
      });

      const inputName = this.selectedFile.name;
      const baseName = inputName.replace(/\.mp4$/i, '');
      const outputName = `${baseName}.mp3`;

      const fileData = await fetchFile(this.selectedFile);
      await this.ffmpeg.writeFile(inputName, fileData);
      
      // Comando otimizado para velocidade
      await this.ffmpeg.exec(['-i', inputName, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', outputName]);

      const mp3Data = await this.ffmpeg.readFile(outputName);
      const mp3Blob = new Blob([mp3Data as Uint8Array], { type: 'audio/mpeg' });
      
      this.outputUrl = URL.createObjectURL(mp3Blob);
      this.outputName = outputName;
      this.progress = 100;

      // Salva no histórico em background
      this.uploadParaStorage(outputName, mp3Blob)
        .then(path => this.salvarLogConversao(outputName, path))
        .then(() => this.carregarConversoes());

      this.showToast('Conversão concluída com sucesso!', 'success');
    } catch (error: any) {
      console.error('FFmpeg Error:', error);
      this.showToast('Falha na conversão: ' + (error.message || 'Erro interno'), 'error');
      this.ffmpegLoaded = false; // Força recarregamento na próxima
    } finally {
      clearTimeout(watchdog);
      this.isConverting = false;
      this.cdr.markForCheck();
    }
  }

  async converterYouTube(): Promise<void> {
    if (!this.youtubeUrl || this.isYtConverting) return;
    
    try {
      this.isYtConverting = true;
      this.ytStatus = 'Extraindo áudio na nuvem...';
      this.cdr.markForCheck();

      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${environment.apiBaseUrl}/api/youtube/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({ youtubeUrl: this.youtubeUrl })
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Erro no servidor');

      this.outputUrl = result.downloadUrl;
      this.outputName = result.fileName;
      this.showToast('Vídeo do YouTube convertido!', 'success');
      this.carregarConversoes();
    } catch (error: any) {
      this.showToast(error.message || 'Erro ao converter YouTube', 'error');
    } finally {
      this.isYtConverting = false;
      this.ytStatus = '';
      this.cdr.markForCheck();
    }
  }

  baixarArquivo(): void {
    if (!this.outputUrl) return;
    const link = document.createElement('a');
    link.href = this.outputUrl;
    link.download = this.outputName || 'audio.mp3';
    link.click();
  }

  private aplicarArquivo(file?: File): void {
    if (file && file.type === 'video/mp4') {
      this.selectedFile = file;
      this.outputUrl = null;
      this.progress = 0;
    } else {
      this.errorMessage = 'Arquivo inválido.';
    }
    this.cdr.markForCheck();
  }

  private async inicializarFfmpeg(): Promise<void> {
    if (this.ffmpegLoaded) return;
    
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await this.ffmpeg.load({
      coreURL: `${baseURL}/ffmpeg-core.js`,
      wasmURL: `${baseURL}/ffmpeg-core.wasm`,
    });
    
    this.ffmpegLoaded = true;
  }

  private async uploadParaStorage(fileName: string, mp3Blob: Blob): Promise<string> {
    if (!this.user) throw new Error('Auth required');
    const path = `${this.user.id}/${Date.now()}-${fileName}`;
    const { error } = await supabase.storage.from('converted-audio').upload(path, mp3Blob);
    if (error) throw error;
    return path;
  }

  private async salvarLogConversao(nomeArquivo: string, storagePath: string): Promise<void> {
    if (!this.user) return;
    await supabase.from('conversoes').insert({
      nome_arquivo: nomeArquivo,
      storage_path: storagePath,
      user_id: this.user.id
    });
  }

  resetForm(tab: 'local' | 'youtube'): void {
    this.currentTab = tab;
    this.youtubeUrl = '';
    this.selectedFile = null;
    this.outputUrl = null;
    this.progress = 0;
    this.errorMessage = '';
    this.successMessage = '';
    this.cdr.markForCheck();
  }

  async carregarConversoes(page: number = 1): Promise<void> {
    if (!this.user) return;
    this.currentPage = page;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${environment.apiBaseUrl}/api/conversoes?page=${page}&limit=${this.pageSize}`, {
        headers: { 'Authorization': `Bearer ${session?.access_token}` }
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      this.conversoes = result.data;
      this.totalPages = result.totalPages;
      this.cdr.markForCheck();
    } catch (e) {
      this.errorMessage = 'Erro ao carregar histórico.';
      this.cdr.markForCheck();
    }
  }

  trackByConversao(index: number, item: Conversao): number { return item.id; }

  changePage(delta: number): void {
    const newPage = this.currentPage + delta;
    if (newPage >= 1 && newPage <= this.totalPages) this.carregarConversoes(newPage);
  }

  setView(view: 'converter' | 'profile' | 'reset-password'): void {
    this.currentView = view;
    this.errorMessage = '';
    this.successMessage = '';
    if (view === 'profile' && this.user) {
      this.name = this.user.user_metadata?.['display_name'] || '';
    }
    this.cdr.markForCheck();
  }
}
