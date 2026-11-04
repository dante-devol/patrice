import { TemplatesApi } from '../../core/api/work.api';
import { firstValueFrom } from 'rxjs';
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { FormArray, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { errorMessage } from '../../core/errors';
import { RequestTemplateFormService } from './request-template-form.service';
import type { QuestionInput } from '../../core/api.types';
import { QuestionRendererComponent } from './question-renderer.component';

/**
 * Request template builder (the authoring host). Drives add/reorder/remove of
 * questions through the RequestTemplateFormService; the QuestionRenderer (authoring
 * mode) draws each question's controls. An empty set is valid (coordination only).
 *
 * - `division` mode loads and saves a division's default template.
 * - `local` mode edits questions in place for a custom task template; the host reads
 *   them with {@link value} when it creates the task.
 */
@Component({
  selector: 'request-template-builder',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, QuestionRendererComponent],
  template: `
    <div class="qn-builder">
      @if (mode === 'division') { <h3>Default request template</h3> }
      @if (error()) { <p class="error">{{ error() }}</p> }
      @if (saved()) { <p class="ok">Saved.</p> }

      <form [formGroup]="form">
        <div formArrayName="questions">
          @for (q of questions.controls; track q; let i = $index) {
            <div class="q-row">
              <div class="q-controls">
                <button type="button" class="secondary" (click)="move(i, -1)" [disabled]="i === 0">↑</button>
                <button type="button" class="secondary" (click)="move(i, 1)" [disabled]="i === questions.length - 1">↓</button>
                <button type="button" class="quiet danger" (click)="remove(i)">Remove</button>
              </div>
              <question-renderer class="grow" mode="authoring" [group]="asGroup(q)" />
            </div>
          } @empty {
            <p class="muted">No questions — this saves as a coordination-only request template.</p>
          }
        </div>
      </form>

      <div class="row">
        <button type="button" class="secondary" (click)="add()">Add question</button>
        @if (mode === 'division') {
          <button type="button" (click)="save()" [disabled]="busy() || form.invalid">Save request template</button>
        }
      </div>
    </div>
  `,
  styles: [
    `.qn-builder { margin-top: 1rem; }
     .q-row { display: flex; gap: 0.5rem; align-items: flex-start; }
     .q-controls { display: flex; flex-direction: column; gap: 0.25rem; }
     .grow { flex: 1; }
     .ok { color: #2d6b50; font-weight: 700; }`,
  ],
})
export class RequestTemplateBuilderComponent implements OnInit {
  private readonly templatesApi = inject(TemplatesApi);
  private readonly forms = inject(RequestTemplateFormService);

  @Input() mode: 'division' | 'local' = 'division';
  /** The division whose default template is edited (division mode). */
  @Input() divisionId = '';

  form = new FormGroup({ questions: new FormArray<FormGroup>([]) });
  readonly busy = signal(false);
  readonly saved = signal(false);
  readonly error = signal<string | null>(null);

  get questions(): FormArray {
    return this.form.get('questions') as FormArray;
  }
  asGroup(c: unknown): FormGroup {
    return c as FormGroup;
  }

  /** The questions as authored (local mode). */
  value(): QuestionInput[] {
    return this.forms.serialize(this.questions);
  }

  /** Whether every question is complete. */
  get valid(): boolean {
    return this.form.valid;
  }

  async ngOnInit(): Promise<void> {
    if (this.mode === 'local') return;
    try {
      const rt = await firstValueFrom(this.templatesApi.getRequestTemplate(this.divisionId));
      this.form = new FormGroup({
        questions: this.forms.authoringForm(rt?.questions ?? []) as FormArray<FormGroup>,
      });
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  add(): void {
    this.saved.set(false);
    this.questions.push(this.forms.newQuestion());
  }

  remove(i: number): void {
    this.saved.set(false);
    this.questions.removeAt(i);
  }

  /** Reorder by swapping with the neighbour in the given direction. */
  move(i: number, dir: -1 | 1): void {
    const j = i + dir;
    if (j < 0 || j >= this.questions.length) return;
    const ctrl = this.questions.at(i);
    this.questions.removeAt(i);
    this.questions.insert(j, ctrl);
    this.saved.set(false);
  }

  async save(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.saved.set(false);
    try {
      const payload = this.forms.serialize(this.questions);
      await firstValueFrom(this.templatesApi.putRequestTemplate(this.divisionId, payload));
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
