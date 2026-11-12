// Камера: выбор устройства, разрешение, зум, фонарик.
import { drawRotated } from './orient.js';
export const RESOLUTIONS = {
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
  '1440': { width: 2560, height: 1440 },
  '2160': { width: 3840, height: 2160 },
};

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = null;
    this.facing = 'environment';
  }

  get track() { return this.stream ? this.stream.getVideoTracks()[0] : null; }

  async start({ deviceId = this.deviceId, resolution = '1080', facing = this.facing } = {}) {
    this.stop();
    const res = RESOLUTIONS[resolution] || RESOLUTIONS['1080'];
    const video = {
      width: { ideal: res.width },
      height: { ideal: res.height },
      frameRate: { ideal: 30 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: facing };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        delete video.deviceId;
        video.facingMode = { ideal: facing };
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } else throw e;
    }
    this.deviceId = this.track.getSettings().deviceId || deviceId || null;
    this.facing = facing;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((r) => this.video.addEventListener('loadedmetadata', r, { once: true }));
    }
    return this.track.getSettings();
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  async devices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  capabilities() {
    const t = this.track;
    return t && t.getCapabilities ? t.getCapabilities() : {};
  }

  async setZoom(z) {
    const t = this.track;
    if (t) await t.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
  }

  async setTorch(on) {
    const t = this.track;
    if (t) await t.applyConstraints({ advanced: [{ torch: !!on }] }).catch(() => {});
  }

  /** Снимок кадра в полном разрешении, без наложения. */
  async snapshot(type = 'image/jpeg', quality = 0.93, rot = 0) {
    const v = this.video;
    const c = document.createElement('canvas');
    // rot — поворот к ориентации, закреплённой в AR (снимок выглядит так же, как экран)
    c.width = rot % 180 ? v.videoHeight : v.videoWidth; c.height = rot % 180 ? v.videoWidth : v.videoHeight;
    drawRotated(c.getContext('2d'), v, v.videoWidth, v.videoHeight, rot, c.width, c.height);
    return new Promise((r) => c.toBlob(r, type, quality));
  }
}
