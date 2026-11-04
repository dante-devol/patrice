import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, of, switchMap, throwError } from 'rxjs';
import { ApiClient, RequestBody } from './client';
import type { components } from './schema';

type TemplateChoice = RequestBody<'/tasks', 'post'>['template'];
type Question = components['schemas']['Question'];
type QuestionInput = RequestBody<'/tasks/{id}/request-template', 'put'>['questions'][number];

/** Tasks, their seats, questions, timeline and submissions. */
@Injectable({ providedIn: 'root' })
export class TasksApi {
  private readonly api = inject(ApiClient);

  listTasks(filters: object = {}, opts: { after?: string; limit?: number } = {}) {
    return this.api.get('/tasks', { query: { ...filters, ...opts } as never });
  }
  getTask(id: string) {
    return this.api.get('/tasks/{id}', { path: { id } });
  }
  /** Create a task; without a template choice it uses the division's default. */
  createTask(body: Omit<RequestBody<'/tasks', 'post'>, 'template'> & { template?: TemplateChoice }) {
    return this.api.post('/tasks', { ...body, template: body.template ?? { kind: 'default' } });
  }
  updateTask(id: string, body: RequestBody<'/tasks/{id}', 'patch'>) {
    return this.api.patch('/tasks/{id}', body, { path: { id } });
  }
  retireTask(id: string) {
    return this.api.post('/tasks/{id}/retire', undefined, { path: { id } });
  }
  claimTask(id: string) {
    return this.api.post('/tasks/{id}/claim', undefined, { path: { id } });
  }
  leaveTask(id: string) {
    return this.api.post('/tasks/{id}/leave', undefined, { path: { id } });
  }
  removeClaimant(taskId: string, userId: string) {
    return this.api.delete('/tasks/{id}/claimants/{userId}', { path: { id: taskId, userId } });
  }
  manageClaims(id: string, body: RequestBody<'/tasks/{id}/claims', 'post'>) {
    return this.api.post('/tasks/{id}/claims', body, { path: { id } });
  }
  changeRequester(id: string, userId: string) {
    return this.api.post('/tasks/{id}/requester', { userId }, { path: { id } });
  }
  completeTask(id: string) {
    return this.api.post('/tasks/{id}/complete', undefined, { path: { id } });
  }
  /** What happened on a task, oldest first, as typed events. */
  getTimeline(id: string) {
    return this.api.get('/tasks/{id}/timeline', { path: { id } });
  }
  /** The task's own questions, or null when the task has none to show (404). */
  getTaskRequestTemplate(id: string) {
    return this.api.get('/tasks/{id}/request-template', { path: { id } }).pipe(
      catchError((e: unknown) => (e instanceof HttpErrorResponse && e.status === 404 ? of(null) : throwError(() => e))),
    );
  }
  putTaskRequestTemplate(id: string, questions: QuestionInput[]) {
    return this.api.put('/tasks/{id}/request-template', { questions }, { path: { id } });
  }

  // ---- Submissions
  listSubmissions(taskId: string) {
    return this.api.get('/tasks/{id}/submissions', { path: { id: taskId } });
  }
  getSubmission(id: string) {
    return this.api.get('/submissions/{id}', { path: { id } });
  }
  submit(taskId: string, answers: RequestBody<'/tasks/{id}/submissions', 'post'>['answers']) {
    return this.api.post('/tasks/{id}/submissions', { answers }, { path: { id: taskId } });
  }
  reviewSubmission(id: string, decision: RequestBody<'/submissions/{id}/review', 'post'>['decision'], comment?: string) {
    return this.api.post('/submissions/{id}/review', { decision, comment }, { path: { id } });
  }
  retireSubmission(id: string, reason: string) {
    return this.api.post('/submissions/{id}/retire', { reason }, { path: { id } });
  }
  /** Upload a file for an attachment answer; it waits for your submit to claim it. */
  uploadForAnswer(taskId: string, file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.api.post('/tasks/{id}/uploads', form, { path: { id: taskId } });
  }
}

/** A division's template library. */
@Injectable({ providedIn: 'root' })
export class TemplatesApi {
  private readonly api = inject(ApiClient);

  listRequestTemplates(divisionId: string) {
    return this.api.get('/divisions/{id}/request-templates', { path: { id: divisionId } });
  }
  getTemplate(id: string) {
    return this.api.get('/request-templates/{id}', { path: { id } });
  }
  createTemplate(divisionId: string, body: RequestBody<'/divisions/{id}/request-templates', 'post'>) {
    return this.api.post('/divisions/{id}/request-templates', body, { path: { id: divisionId } });
  }
  updateTemplate(id: string, body: RequestBody<'/request-templates/{id}', 'patch'>) {
    return this.api.patch('/request-templates/{id}', body, { path: { id } });
  }
  deleteTemplate(id: string) {
    return this.api.delete('/request-templates/{id}', { path: { id } });
  }

  /** The division's default template, or null when it has none. */
  getRequestTemplate(divisionId: string) {
    return this.listRequestTemplates(divisionId).pipe(
      switchMap((lib) => {
        const d = lib.items.find((t) => t.isDefault);
        return d ? this.getTemplate(d.id) : of(null);
      }),
    );
  }

  /** Replace the default template's questions, creating the default if there is none. */
  putRequestTemplate(divisionId: string, questions: QuestionInput[]) {
    return this.listRequestTemplates(divisionId).pipe(
      map((lib) => lib.items.find((t) => t.isDefault)),
      switchMap((current) =>
        current
          ? this.updateTemplate(current.id, { questions, version: current.version })
          : this.createTemplate(divisionId, { name: 'Default', isDefault: true, questions }),
      ),
    );
  }
}

/** A task's thread and its files. */
@Injectable({ providedIn: 'root' })
export class MessagesApi {
  private readonly api = inject(ApiClient);

  listMessages(taskId: string, opts: { after?: string; limit?: number } = {}) {
    return this.api.get('/tasks/{id}/messages', { path: { id: taskId }, query: opts as never });
  }
  createMessage(taskId: string, body: RequestBody<'/tasks/{id}/messages', 'post'>) {
    return this.api.post('/tasks/{id}/messages', body, { path: { id: taskId } });
  }
  updateMessage(id: string, body: string) {
    return this.api.patch('/messages/{id}', { body }, { path: { id } });
  }
  /** Deleted outright; a message with replies stays as an empty marker. */
  deleteMessage(id: string) {
    return this.api.delete('/messages/{id}', { path: { id } });
  }
  uploadAttachment(messageId: string, file: File) {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.api.post('/messages/{id}/attachments', form, { path: { id: messageId } });
  }
  deleteAttachment(id: string) {
    return this.api.delete('/attachments/{id}', { path: { id } });
  }
  /** The download URL for an attachment (use as an anchor href). */
  attachmentUrl(id: string): string {
    return `/api/attachments/${encodeURIComponent(id)}`;
  }
}

/** The caller's notifications. */
@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly api = inject(ApiClient);
  /** The SSE endpoint an EventSource subscribes to (cookie-authed). */
  readonly notificationStreamUrl = '/api/notifications/stream';

  listNotifications(opts: { after?: string; limit?: number } = {}) {
    return this.api.get('/notifications', { query: opts as never });
  }
  markNotificationRead(id: string) {
    return this.api.post('/notifications/{id}/read', undefined, { path: { id } });
  }
  markAllNotificationsRead() {
    return this.api.post('/notifications/read-all');
  }
}

/** Integration connections and group mappings. */
@Injectable({ providedIn: 'root' })
export class IntegrationsApi {
  private readonly api = inject(ApiClient);

  listIntegrations(includeRetired = false) {
    return this.api.get('/integrations', { query: (includeRetired ? { include: 'retired' } : undefined) as never });
  }
  connectIntegration(body: RequestBody<'/integrations', 'post'>) {
    return this.api.post('/integrations', body);
  }
  updateIntegration(id: string, body: RequestBody<'/integrations/{id}', 'patch'>) {
    return this.api.patch('/integrations/{id}', body, { path: { id } });
  }
  rotateToken(id: string, botToken: string) {
    return this.api.post('/integrations/{id}/rotate-token', { botToken }, { path: { id } });
  }
  /** Retire; `grants` is applied to what the connection granted once it's collected. */
  retireIntegration(id: string, grants: 'keep' | 'revoke' = 'keep') {
    return this.api.post('/integrations/{id}/retire', { grants }, { path: { id } });
  }
  reviveIntegration(id: string) {
    return this.api.post('/integrations/{id}/revive', undefined, { path: { id } });
  }
  listMappings(connectionId: string) {
    return this.api.get('/integrations/{id}/mappings', { path: { id: connectionId } });
  }
  createMapping(connectionId: string, body: RequestBody<'/integrations/{id}/mappings', 'post'>) {
    return this.api.post('/integrations/{id}/mappings', body, { path: { id: connectionId } });
  }
  /** Delete a mapping, keeping (default) or revoking what it granted. */
  deleteMapping(connectionId: string, mappingId: string, grants: 'keep' | 'revoke' = 'keep') {
    return this.api.delete('/integrations/{id}/mappings/{mappingId}', {
      path: { id: connectionId, mappingId },
      query: { grants },
    });
  }
  retryMapping(connectionId: string, mappingId: string) {
    return this.api.post('/integrations/{id}/mappings/{mappingId}/retry', undefined, { path: { id: connectionId, mappingId } });
  }
  triggerSync(connectionId: string) {
    return this.api.post('/integrations/{id}/sync', undefined, { path: { id: connectionId } });
  }
}

export type { Question, QuestionInput, TemplateChoice };
