import { CommonModule } from '@angular/common';
import { Component, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
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
  isYtConverting = false;

  // View state
  currentView: 'converter' | 'profile' | 'reset-password' = 'converter';
  
  // Pagination state
  currentPage = 1;
  totalPages = 1;
  pageSize = 5;

  selectedFile: File | null = null;
  isDragging = false;
  isConverting = false;
  progress = 0;
  errorMessage = '';
  successMessage = '';
  outputUrl: string | null = null;
  outputName = '';
  conversoes: Conversao[] = [];

  private ffmpeg = new FFmpeg();
  private ffmpegLoaded = false;

  constructor(private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    // 1. Detectar se é um fluxo de recuperação de senha
    const hash = window.location.hash;
    if (hash && hash.includes('type=recovery')) {
      this.currentView = 'reset-password';
    }

    const { data: { session } } = await supabase.auth.getSession();
    this.user = session?.user ?? null;
    this.isAuthLoading = false;

    if (this.user) {
      await this.carregarConversoes();
      this.inicializarFfmpeg(); // Inicia em background
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      this.user = session?.user ?? null;
      
      if (event === 'PASSWORD_RECOVERY') {
        this.currentView = 'reset-password';
      }

      if (this.user) {
        await this.carregarConversoes();
        this.inicializarFfmpeg(); // Warmup
      } else {
        this.conversoes = [];
        this.currentView = 'converter';
      }
      this.cdr.markForCheck();
    });
  }

  async signIn(): Promise<void> {
    this.errorMessage = '';
    const { error } = await supabase.auth.signInWithPassword({
      email: this.email,
      password: this.password
    });
    if (error) this.errorMessage = error.message;
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
      options: {
        data: {
          display_name: this.name
        }
      }
    });

    if (error) this.errorMessage = error.message;
    else this.successMessage = 'Confirme seu e-mail para continuar.';
  }

  get userDisplayName(): string {
    return this.user?.user_metadata?.['display_name'] || this.user?.email || 'Usuário';
  }

  async updateProfile(): Promise<void> {
    if (!this.name) {
      this.errorMessage = 'O nome não pode estar vazio.';
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    const { error } = await supabase.auth.updateUser({
      data: { display_name: this.name }
    });

    if (error) {
      this.errorMessage = error.message;
    } else {
      this.successMessage = 'Perfil atualizado com sucesso!';
    }
  }

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
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

    // Se estiver no perfil (não no reset), validar senha atual
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

    const { error } = await supabase.auth.updateUser({
      password: this.newPassword
    });

    if (error) {
      this.errorMessage = error.message;
    } else {
      this.successMessage = 'Senha atualizada com sucesso!';
      this.newPassword = '';
      this.currentPassword = '';
      if (this.currentView === 'reset-password') {
        this.currentView = 'converter';
      }
    }
  }

  async forgotPassword(): Promise<void> {
    if (!this.email) {
      this.errorMessage = 'Insira seu e-mail para recuperar a senha.';
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    const { error } = await supabase.auth.resetPasswordForEmail(this.email, {
      redirectTo: `${window.location.origin}`
    });

    if (error) {
      this.errorMessage = error.message;
    } else {
      this.successMessage = 'E-mail de recuperação enviado! Verifique sua caixa de entrada.';
    }
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
    if (!this.selectedFile || this.isConverting) {
      return;
    }

    this.isConverting = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.progress = 0;
    this.outputUrl = null;

    try {
      await this.inicializarFfmpeg();
      this.ffmpeg.on('progress', ({ progress }) => {
        this.progress = Math.round(progress * 100);
        this.cdr.markForCheck();
      });

      const inputName = this.selectedFile.name;
      const baseName = inputName.replace(/\.mp4$/i, '');
      const outputName = `${baseName}.mp3`;

      await this.ffmpeg.writeFile(inputName, await fetchFile(this.selectedFile));
      await this.ffmpeg.exec([
        '-i',
        inputName,
        '-vn',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-b:a',
        '192k',
        outputName
      ]);

      const mp3Data = await this.ffmpeg.readFile(outputName);
      const mp3Blob = new Blob([mp3Data as Uint8Array], { type: 'audio/mpeg' });
      this.outputUrl = URL.createObjectURL(mp3Blob);
      this.outputName = outputName;
      this.progress = 100;

      const storagePath = await this.uploadParaStorage(outputName, mp3Blob);
      await this.salvarLogConversao(outputName, storagePath);
      await this.carregarConversoes();

      this.successMessage = 'Conversão concluída com sucesso.';
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Falha ao converter arquivo.';
    } finally {
      this.isConverting = false;
    }
  }

  async converterYouTube(): Promise<void> {
    if (!this.youtubeUrl || this.isYtConverting) return;

    this.isYtConverting = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.progress = 0;

    try {
      // Obter o token de sessão do Supabase
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

      if (!response.ok) {
        throw new Error(result.error || 'Falha na conversão do YouTube.');
      }

      this.outputUrl = result.downloadUrl;
      this.outputName = result.fileName;
      this.successMessage = 'Vídeo do YouTube convertido com sucesso!';
      this.youtubeUrl = '';
      await this.carregarConversoes();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : 'Erro ao converter YouTube.';
    } finally {
      this.isYtConverting = false;
    }
  }

  baixarArquivo(): void {
    if (!this.outputUrl) {
      return;
    }

    const link = document.createElement('a');
    link.href = this.outputUrl;
    link.download = this.outputName || 'audio-convertido.mp3';
    link.click();
  }

  private aplicarArquivo(file?: File): void {
    this.errorMessage = '';
    this.successMessage = '';

    if (file && file.type === 'video/mp4') {
      this.selectedFile = file;
      this.errorMessage = '';
      this.outputUrl = '';
      this.progress = 0;
    } else {
      this.errorMessage = 'Por favor, selecione um arquivo MP4 válido.';
      this.selectedFile = null;
    }
    this.cdr.markForCheck();
  }

  private async inicializarFfmpeg(): Promise<void> {
    if (this.ffmpegLoaded) {
      return;
    }

    await this.ffmpeg.load();
    this.ffmpegLoaded = true;
  }

  private async uploadParaStorage(fileName: string, mp3Blob: Blob): Promise<string> {
    if (!this.user) throw new Error('Usuário não autenticado.');
    
    const timestamp = Date.now();
    const uniquePath = `${this.user.id}/${timestamp}-${fileName}`;

    const { error } = await supabase.storage
      .from('converted-audio')
      .upload(uniquePath, mp3Blob, {
        contentType: 'audio/mpeg',
        upsert: false
      });

    if (error) {
      throw new Error(`Falha no upload para Storage: ${error.message}`);
    }

    return uniquePath;
  }

  private async salvarLogConversao(
    nomeArquivo: string,
    storagePath: string
  ): Promise<void> {
    if (!this.user) return;

    const { error } = await supabase.from('conversoes').insert({
      nome_arquivo: nomeArquivo,
      storage_path: storagePath,
      user_id: this.user.id
    });

    if (error) {
      throw new Error(`Falha ao salvar log: ${error.message}`);
    }
  }

  async carregarConversoes(page: number = 1): Promise<void> {
    if (!this.user) return;

    this.currentPage = page;
    const { data: { session } } = await supabase.auth.getSession();

    try {
      const response = await fetch(`${environment.apiBaseUrl}/api/conversoes?page=${page}&limit=${this.pageSize}`, {
        headers: {
          'Authorization': `Bearer ${session?.access_token}`
        }
      });

      const result = await response.json();

      if (!response.ok) throw new Error(result.error);

      this.conversoes = result.data as Conversao[];
      this.totalPages = result.totalPages;
      this.cdr.markForCheck();
    } catch (error) {
      this.errorMessage = 'Não foi possível carregar o histórico.';
      this.cdr.markForCheck();
    }
  }

  trackByConversao(index: number, item: Conversao): number {
    return item.id;
  }

  changePage(delta: number): void {
    const newPage = this.currentPage + delta;
    if (newPage >= 1 && newPage <= this.totalPages) {
      this.carregarConversoes(newPage);
    }
  }

  setView(view: 'converter' | 'profile' | 'reset-password'): void {
    this.currentView = view;
    this.errorMessage = '';
    this.successMessage = '';
  }
}
