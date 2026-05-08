import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
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
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit {
  // Auth state
  user: User | null = null;
  email = '';
  password = '';
  confirmPassword = '';
  name = '';
  isAuthLoading = true;
  authMode: 'login' | 'signup' = 'login';
  newPassword = '';

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

  async ngOnInit(): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    this.user = session?.user ?? null;
    this.isAuthLoading = false;

    if (this.user) {
      await this.carregarConversoes();
    }

    supabase.auth.onAuthStateChange(async (_event, session) => {
      this.user = session?.user ?? null;
      if (this.user) {
        await this.carregarConversoes();
      } else {
        this.conversoes = [];
      }
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
  }

  async updatePassword(): Promise<void> {
    if (!this.newPassword || this.newPassword.length < 6) {
      this.errorMessage = 'A senha deve ter pelo menos 6 caracteres.';
      return;
    }

    this.errorMessage = '';
    this.successMessage = '';

    const { error } = await supabase.auth.updateUser({
      password: this.newPassword
    });

    if (error) {
      this.errorMessage = error.message;
    } else {
      this.successMessage = 'Senha atualizada com sucesso!';
      this.newPassword = '';
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

    if (!file) {
      this.selectedFile = null;
      return;
    }

    if (!file.name.toLowerCase().endsWith('.mp4')) {
      this.errorMessage = 'Selecione um arquivo .mp4 válido.';
      this.selectedFile = null;
      return;
    }

    this.selectedFile = file;
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

  private async carregarConversoes(): Promise<void> {
    if (!this.user) return;

    const { data, error } = await supabase
      .from('conversoes')
      .select('id, nome_arquivo, criado_em')
      .eq('user_id', this.user.id)
      .order('criado_em', { ascending: false })
      .limit(5);

    if (error) {
      this.errorMessage = 'Não foi possível carregar o histórico.';
      return;
    }

    this.conversoes = data as Conversao[];
  }
}
