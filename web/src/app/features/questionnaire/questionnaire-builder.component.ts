import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { FormArray, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { errorMessage } from '../../core/errors';
import { QuestionnaireFormService } from './questionnaire-form.service';
import { QuestionRendererComponent } from './question-renderer.component';

/**
 * Questionnaire builder (authoring host, Slice 3). Loads a division's default
 * questionnaire, drives add/reorder/remove of questions through the
 * QuestionnaireFormService, and the QuestionRenderer (authoring mode) draws each
 * question's controls. Saving PUTs the whole replace-in-place question set. An empty
 * set is valid (a coordination-only division).
 */
@Component({
  selector: 'questionnaire-builder',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, QuestionRendererComponent],
  template: `
    <div class="qn-builder">
      <h3>Default questionnaire</h3>
      @if (error()) { <p class="error">{{ error() }}</p> }
      @if (saved()) { <p class="ok">Saved.</p> }

      <form [formGroup]="form">
        <div formArrayName="questions">
          @for (q of questions.controls; track q; let i = $index) {
            <div class="q-row">
              <div class="q-controls">
                <button type="button" class="secondary" (click)="move(i, -1)" [disabled]="i === 0">↑</button>
                <button type="button" class="secondary" (click)="move(i, 1)" [disabled]="i === questions.length - 1">↓</button>
                <button type="button" class="secondary" (click)="remove(i)">Remove</button>
              </div>
              <question-renderer class="grow" mode="authoring" [group]="asGroup(q)" />
            </div>
          } @empty {
            <p class="muted">No questions — this saves as a coordination-only questionnaire.</p>
          }
        </div>
      </form>

      <div class="row">
        <button type="button" class="secondary" (click)="add()">Add question</button>
        <button type="button" (click)="save()" [disabled]="busy() || form.invalid">Save questionnaire</button>
      </div>
    </div>
  `,
  styles: [
    `.qn-builder { margin-top: 1rem; }
     .q-row { display: flex; gap: 0.5rem; align-items: flex-start; }
     .q-controls { display: flex; flex-direction: column; gap: 0.25rem; }
     .grow { flex: 1; }
     .ok { color: #2a7; }`,
  ],
})
export class QuestionnaireBuilderComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly forms = inject(QuestionnaireFormService);

  @Input({ required: true }) divisionId!: string;

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

  async ngOnInit(): Promise<void> {
    try {
      const qn = await this.api.getQuestionnaire(this.divisionId);
      this.form = new FormGroup({
        questions: this.forms.authoringForm(qn?.questions ?? []) as FormArray<FormGroup>,
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
      await this.api.putQuestionnaire(this.divisionId, payload);
      this.saved.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
