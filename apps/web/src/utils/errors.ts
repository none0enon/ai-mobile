import { errorReport } from '@app/ai';
import { showDialog, showToast } from 'vant';

/** 复制到剪贴板；不支持 Clipboard API 的 WebView 用老办法 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export async function copyWithToast(text: string): Promise<void> {
  showToast((await copyText(text)) ? '已复制' : '复制不了，长按文字手动复制');
}

/**
 * 弹窗显示完整报错（请求地址、状态码、服务端原文……），可以复制。
 * 用在本来只会弹一句 Toast 的地方：Toast 放不下，也会自动消失
 */
export function showErrorDialog(title: string, e: unknown): void {
  const detail = typeof e === 'string' ? e : errorReport(e);
  void showDialog({
    title,
    message: detail,
    messageAlign: 'left',
    className: 'error-dialog',
    showCancelButton: true,
    cancelButtonText: '关闭',
    confirmButtonText: '复制',
  })
    .then(() => copyWithToast(detail))
    .catch(() => undefined);
}
