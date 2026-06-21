import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { avatarColor, initials } from './task-presentation';

/**
 * A user avatar for the Tasks slice. Today it renders the initials fallback on a stable
 * per-user colour; once Slice 8 (Discord) lands, `imageUrl` carries the CDN avatar and
 * the initials become the load/empty fallback. An empty (`unclaimed`) state renders the
 * dashed open-slot circle. Kept presentational — no data fetching.
 */
@Component({
  selector: 'user-avatar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (empty()) {
      <span class="avatar avatar--empty" [style.width.px]="size()" [style.height.px]="size()"
            [title]="title() || 'unclaimed — open to claims'"></span>
    } @else {
      <span class="avatar" [style.width.px]="size()" [style.height.px]="size()"
            [style.background]="color()" [style.fontSize.px]="fontPx()" [title]="title() || name()">
        @if (imageUrl()) {
          <img [src]="imageUrl()" [alt]="name()" />
        } @else {
          {{ label() }}
        }
      </span>
    }
  `,
})
export class UserAvatarComponent {
  readonly name = input('');
  /** Stable colour/identity seed; defaults to the name. */
  readonly seed = input<string>('');
  readonly size = input(26);
  readonly title = input<string>('');
  readonly imageUrl = input<string | null>(null);
  /** Dashed open-slot circle (an unclaimed single opening). */
  readonly empty = input(false);

  readonly label = computed(() => initials(this.name()));
  readonly color = computed(() => avatarColor(this.seed() || this.name()));
  readonly fontPx = computed(() => Math.max(9, Math.round(this.size() * 0.4)));
}
