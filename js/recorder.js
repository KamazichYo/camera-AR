// Запись видео с камеры (чистый кадр — без референса).
// Данные пишутся потоком в OPFS (диск браузера), если он доступен, —
// так часовая сессия рисования не съедает оперативную память и
// переживает внезапное закрытие вкладки.

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime(withAudio) {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    const mm = withAudio ? m : m.replace(/,(mp4a\.40\.2|opus)/, '');
    if (MediaRecorder.isTypeSupported(mm)) return mm;
  }
  return '';
}

export const extFor = (mime) => (mime && mime.includes('mp4') ? 'mp4' : 'webm');

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function opfsDir() {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('recordings', { create: true });
  } catch { return null; }
}

/** Незавершённые записи (например, вкладка закрылась во время записи). */
export async function findOrphans() {
  const dir = await opfsDir();
  if (!dir) return [];
  const out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== 'file' || !name.endsWith('.part')) continue;
    const file = await h.getFile();
    if (file.size > 0) out.push({ name, file, handle: h });
    else await dir.removeEntry(name).catch(() => {});
  }
  return out;
}

export async function removeRecordingFile(name) {
  const dir = await opfsDir();
  if (dir) await dir.removeEntry(name).catch(() => {});
}

export class Recorder {
  constructor() {
    this.rec = null;
    this.audio = null;
    this.startedAt = 0;
    this.pausedMs = 0;
    this.pauseAt = 0;
  }

  get state() { return this.rec ? this.rec.state : 'inactive'; }

  get elapsed() {
    if (!this.rec) return 0;
    const now = this.rec.state === 'paused' ? this.pauseAt : performance.now();
    return now - this.startedAt - this.pausedMs;
  }

  async start(videoTrack, { audio = false, bitrate = 6_000_000 } = {}) {
    if (this.rec) throw new Error('Запись уже идёт');
    const tracks = [videoTrack];
    if (audio) {
      try {
        this.audio = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        tracks.push(...this.audio.getAudioTracks());
      } catch (e) {
        console.warn('Микрофон недоступен', e);
        this.audio = null;
      }
    }
    const stream = new MediaStream(tracks);
    this.mime = pickMime(!!this.audio);
    if (this.mime === null) throw new Error('Браузер не поддерживает запись видео (MediaRecorder)');
    const opts = { videoBitsPerSecond: bitrate };
    if (this.mime) opts.mimeType = this.mime;
    this.rec = new MediaRecorder(stream, opts);
    this.mime = this.rec.mimeType || this.mime || 'video/webm';

    // хранилище
    this.name = `art-${stamp()}.${extFor(this.mime)}`;
    this.chunks = [];
    this.writable = null;
    this.writeChain = Promise.resolve();
    const dir = await opfsDir();
    if (dir) {
      try {
        this.fileHandle = await dir.getFileHandle(this.name + '.part', { create: true });
        if (this.fileHandle.createWritable) this.writable = await this.fileHandle.createWritable();
      } catch (e) { console.warn('OPFS недоступен', e); this.writable = null; }
    }
    if (!this.writable) this.fileHandle = null;

    this.rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      if (this.writable) {
        this.writeChain = this.writeChain.then(() => this.writable.write(e.data)).catch((err) => {
          // диск переполнен / ошибка — продолжаем в памяти
          console.warn('Ошибка записи на диск, переключаюсь на память', err);
          this.chunks.push(e.data);
        });
      } else this.chunks.push(e.data);
    };
    this.stopped = new Promise((r) => { this.rec.onstop = r; });
    this.rec.start(1000);
    this.startedAt = performance.now();
    this.pausedMs = 0;
  }

  pause() {
    if (this.rec && this.rec.state === 'recording') { this.rec.pause(); this.pauseAt = performance.now(); }
  }

  resume() {
    if (this.rec && this.rec.state === 'paused') { this.rec.resume(); this.pausedMs += performance.now() - this.pauseAt; }
  }

  /** Останавливает запись и возвращает { blob, name, mime, duration }. */
  async stop() {
    if (!this.rec) return null;
    const duration = this.elapsed;
    this.rec.stop();
    await this.stopped;
    await this.writeChain;
    if (this.audio) this.audio.getTracks().forEach((t) => t.stop());
    this.audio = null;
    let blob;
    let storedName = null;
    if (this.writable) {
      await this.writable.close();
      // переименовать .part → готовый файл не обязательно: просто читаем
      const file = await this.fileHandle.getFile();
      blob = this.chunks.length ? new Blob([file, ...this.chunks], { type: this.mime }) : file.slice(0, file.size, this.mime);
      storedName = this.name + '.part';
    } else {
      blob = new Blob(this.chunks, { type: this.mime });
    }
    const res = { blob, name: this.name, mime: this.mime, duration, storedName };
    this.rec = null; this.chunks = []; this.writable = null;
    return res;
  }
}
