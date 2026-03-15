/**
 * 音频播放管理器
 * - 播放 public/sounds 下的真实音频文件
 * - 支持音量控制、重试机制、预加载缓存
 */

export interface PlayOptions {
  volume?: number; // 0-1
  maxRetries?: number;
}

export class AudioPlayer {
  private preloadedAudio = new Map<string, HTMLAudioElement>();

  /**
   * 获取（或创建）预加载音频对象
   */
  private getOrCreateAudio(soundPath: string): HTMLAudioElement {
    const cached = this.preloadedAudio.get(soundPath);
    if (cached) {
      return cached;
    }

    const audio = new Audio(soundPath);
    audio.preload = 'auto';
    this.preloadedAudio.set(soundPath, audio);
    return audio;
  }

  /**
   * 播放指定音频文件（支持重试）
   */
  async playSound(
    soundPath: string,
    options: PlayOptions = {}
  ): Promise<void> {
    const { volume = 0.5, maxRetries = 2 } = options;
    const normalizedVolume = Math.max(0, Math.min(1, volume));

    // 服务端环境检查
    if (typeof window === 'undefined') {
      console.debug('[AudioPlayer] 服务端环境，跳过播放');
      return;
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const baseAudio = this.getOrCreateAudio(soundPath);
        // clone 以支持连续触发时的并行播放，不影响预加载缓存
        const audio = baseAudio.cloneNode(true) as HTMLAudioElement;
        audio.volume = normalizedVolume;
        audio.currentTime = 0;

        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            audio.onended = null;
            audio.onerror = null;
          };

          audio.onended = () => {
            cleanup();
            resolve();
          };

          audio.onerror = () => {
            cleanup();
            reject(new Error('audio playback failed'));
          };

          const playPromise = audio.play();
          if (playPromise) {
            playPromise.catch((error: unknown) => {
              cleanup();
              reject(error instanceof Error ? error : new Error('audio play rejected'));
            });
          }
        });

        return;
      } catch (error) {
        if (attempt === maxRetries - 1) {
          console.error('[AudioPlayer] 音频播放失败:', error);
        } else {
          // 重试
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }
  }

  /**
   * 预加载音频文件到内存
   */
  async preload(soundPath: string): Promise<void> {
    if (typeof window === 'undefined') {
      return;
    }

    const audio = this.getOrCreateAudio(soundPath);

    if (audio.readyState >= 3) {
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        audio.removeEventListener('canplaythrough', finish);
        audio.removeEventListener('error', finish);
        resolve();
      };
      audio.addEventListener('canplaythrough', finish, { once: true });
      audio.addEventListener('error', finish, { once: true });
      audio.load();
    });
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    for (const audio of this.preloadedAudio.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
    this.preloadedAudio.clear();
  }
}
