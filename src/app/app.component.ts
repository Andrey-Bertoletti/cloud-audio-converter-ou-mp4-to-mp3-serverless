import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { supabase } from './supabase.client';
import { environment } from '../environments/environment';

type Conversao = {
  id: number;
  nome_arquivo: string;
  criado_em: string;
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit {
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
    await this.carregarConversoes();
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
    const timestamp = Date.now();
    const uniquePath = `${timestamp}-${fileName}`;

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
    const response = await fetch(`${environment.apiBaseUrl}/api/conversoes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        nomeArquivo,
        storagePath
      })
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? 'Falha ao salvar log de conversão.');
    }
  }

  private async carregarConversoes(): Promise<void> {
    const response = await fetch(`${environment.apiBaseUrl}/api/conversoes`);
    if (!response.ok) {
      this.errorMessage = 'Não foi possível carregar o histórico de conversões.';
      return;
    }

    const data = (await response.json()) as Conversao[];
    this.conversoes = data;
  }
}
