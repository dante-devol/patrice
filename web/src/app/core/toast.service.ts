import { Injectable } from '@angular/core';
import { toast } from 'ngx-sonner';

/**
 * Thin wrapper over ngx-sonner so components depend on an injectable rather than a
 * free function (easier to stub in tests, and one place to tune defaults). Toasts are
 * for transient action feedback — "Claimed", "Submitted for review", and API errors —
 * not for anything the History/timeline already records durably.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  success(message: string): void {
    toast.success(message);
  }
  error(message: string): void {
    toast.error(message);
  }
  info(message: string): void {
    toast(message);
  }
}
