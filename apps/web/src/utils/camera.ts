/** 浏览器能不能在 App 里直接开相机（getUserMedia 要 https）；不能时改用系统相机（<input capture>） */
export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window !== 'undefined' && window.isSecureContext;
}
