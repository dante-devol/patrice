import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  AdminUser,
  Attachment,
  BootstrapStatus,
  CreatedInvitation,
  CurrentUser,
  Division,
  Grant,
  InvitationListItem,
  InviteView,
  Message,
  MessageListResult,
  OrgSettings,
  Questionnaire,
  QuestionInput,
  ReviewDecision,
  Role,
  ScopeKind,
  Submission,
  SubmitAnswer,
  Task,
  TaskFilters,
  TaskListResult,
  Team,
} from './api.types';

/**
 * The OpenAPI data layer (hand-written for Slice 1 — see api.types.ts note). All
 * calls are same-origin with credentials; the interceptors attach cookies + CSRF.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  bootstrapStatus(): Promise<BootstrapStatus> {
    return firstValueFrom(this.http.get<BootstrapStatus>('/api/bootstrap'));
  }

  me(): Promise<CurrentUser> {
    return firstValueFrom(this.http.get<CurrentUser>('/api/me'));
  }

  login(email: string, password: string): Promise<CurrentUser> {
    return firstValueFrom(
      this.http.post<CurrentUser>('/api/auth/login', { email, password }),
    );
  }

  logout(): Promise<void> {
    return firstValueFrom(this.http.post<void>('/api/auth/logout', {}));
  }

  viewInvite(token: string): Promise<InviteView> {
    return firstValueFrom(this.http.get<InviteView>(`/api/invite/${token}`));
  }

  acceptInvite(
    token: string,
    body: { passcode?: string; email: string; password: string; displayName: string },
  ): Promise<CurrentUser> {
    return firstValueFrom(
      this.http.post<CurrentUser>(`/api/invite/${token}/accept`, body),
    );
  }

  createInvitation(body: { email?: string }): Promise<CreatedInvitation> {
    return firstValueFrom(this.http.post<CreatedInvitation>('/api/invitations', body));
  }

  listInvitations(): Promise<InvitationListItem[]> {
    return firstValueFrom(this.http.get<InvitationListItem[]>('/api/invitations'));
  }

  revokeInvitation(id: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/invitations/${id}/revoke`, {}));
  }

  requestPasswordReset(email: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/password-reset', { email }),
    );
  }

  confirmPasswordReset(token: string, password: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/password-reset/confirm', { token, password }),
    );
  }

  confirmVerification(token: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/verify-email/confirm', { token }),
    );
  }

  resendVerification(email: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>('/api/auth/verify-email/resend', { email }),
    );
  }

  // ---- Slice 2: org configuration ----------------------------------------

  listRoles(): Promise<Role[]> {
    return firstValueFrom(this.http.get<Role[]>('/api/roles'));
  }
  createRole(name: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>('/api/roles', { name }));
  }
  updateRole(id: string, name: string): Promise<Role> {
    return firstValueFrom(this.http.patch<Role>(`/api/roles/${id}`, { name }));
  }
  retireRole(id: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>(`/api/roles/${id}/retire`, {}));
  }
  reviveRole(id: string): Promise<Role> {
    return firstValueFrom(this.http.post<Role>(`/api/roles/${id}/revive`, {}));
  }

  listDivisions(): Promise<Division[]> {
    return firstValueFrom(this.http.get<Division[]>('/api/divisions'));
  }
  createDivision(body: Partial<Division> & { name: string }): Promise<Division> {
    return firstValueFrom(this.http.post<Division>('/api/divisions', body));
  }
  updateDivision(id: string, body: Partial<Division>): Promise<Division> {
    return firstValueFrom(this.http.patch<Division>(`/api/divisions/${id}`, body));
  }
  retireDivision(id: string): Promise<Division> {
    return firstValueFrom(this.http.post<Division>(`/api/divisions/${id}/retire`, {}));
  }
  reviveDivision(id: string): Promise<Division> {
    return firstValueFrom(this.http.post<Division>(`/api/divisions/${id}/revive`, {}));
  }

  listTeams(): Promise<Team[]> {
    return firstValueFrom(this.http.get<Team[]>('/api/teams'));
  }
  createTeam(body: { name: string; restrictClaims?: boolean }): Promise<Team> {
    return firstValueFrom(this.http.post<Team>('/api/teams', body));
  }
  updateTeam(id: string, body: Partial<Team>): Promise<Team> {
    return firstValueFrom(this.http.patch<Team>(`/api/teams/${id}`, body));
  }
  retireTeam(id: string): Promise<Team> {
    return firstValueFrom(this.http.post<Team>(`/api/teams/${id}/retire`, {}));
  }
  reviveTeam(id: string): Promise<Team> {
    return firstValueFrom(this.http.post<Team>(`/api/teams/${id}/revive`, {}));
  }

  listActions(): Promise<{ actions: string[] }> {
    return firstValueFrom(this.http.get<{ actions: string[] }>('/api/actions'));
  }
  listGrants(): Promise<Grant[]> {
    return firstValueFrom(this.http.get<Grant[]>('/api/grants'));
  }
  createGrant(body: {
    roleId: string;
    action: string;
    scopeKind: ScopeKind;
    scopeDivisionId?: string;
    scopeTeamId?: string;
    scopeRoleId?: string;
  }): Promise<Grant> {
    return firstValueFrom(this.http.post<Grant>('/api/grants', body));
  }
  retireGrant(id: string): Promise<Grant> {
    return firstValueFrom(this.http.post<Grant>(`/api/grants/${id}/retire`, {}));
  }

  listUsers(): Promise<AdminUser[]> {
    return firstValueFrom(this.http.get<AdminUser[]>('/api/users'));
  }
  grantUserRole(userId: string, roleId: string): Promise<void> {
    return firstValueFrom(
      this.http.post<void>(`/api/users/${userId}/roles`, { roleId }),
    );
  }
  revokeUserRole(userId: string, roleId: string): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/users/${userId}/roles/${roleId}`));
  }
  deactivateUser(userId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/users/${userId}/deactivate`, {}));
  }
  reactivateUser(userId: string): Promise<void> {
    return firstValueFrom(this.http.post<void>(`/api/users/${userId}/reactivate`, {}));
  }

  // ---- Slice 3: questionnaires -------------------------------------------

  /** A division's default questionnaire, or null when it has none yet (404). */
  async getQuestionnaire(divisionId: string): Promise<Questionnaire | null> {
    try {
      return await firstValueFrom(
        this.http.get<Questionnaire>(`/api/divisions/${divisionId}/questionnaire`),
      );
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 404) return null;
      throw e;
    }
  }

  putQuestionnaire(
    divisionId: string,
    questions: QuestionInput[],
  ): Promise<Questionnaire> {
    return firstValueFrom(
      this.http.put<Questionnaire>(`/api/divisions/${divisionId}/questionnaire`, {
        questions,
      }),
    );
  }

  getConfig(): Promise<OrgSettings> {
    return firstValueFrom(this.http.get<OrgSettings>('/api/config'));
  }
  updateConfig(body: Partial<OrgSettings>): Promise<OrgSettings> {
    return firstValueFrom(this.http.patch<OrgSettings>('/api/config', body));
  }

  // ---- Slice 4: tasks -----------------------------------------------------

  listTasks(
    filters: TaskFilters = {},
    opts: { after?: string; limit?: number } = {},
  ): Promise<TaskListResult> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v);
    }
    if (opts.after) params.set('after', opts.after);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return firstValueFrom(
      this.http.get<TaskListResult>(`/api/tasks${qs ? `?${qs}` : ''}`),
    );
  }

  getTask(id: string): Promise<Task> {
    return firstValueFrom(this.http.get<Task>(`/api/tasks/${id}`));
  }

  createTask(body: {
    name: string;
    description?: string;
    divisionId: string;
    teamId?: string;
  }): Promise<Task> {
    return firstValueFrom(this.http.post<Task>('/api/tasks', body));
  }

  updateTask(id: string, body: { name?: string; description?: string }): Promise<Task> {
    return firstValueFrom(this.http.patch<Task>(`/api/tasks/${id}`, body));
  }

  retireTask(id: string): Promise<Task> {
    return firstValueFrom(this.http.post<Task>(`/api/tasks/${id}/retire`, {}));
  }

  claimTask(id: string): Promise<Task> {
    return firstValueFrom(this.http.post<Task>(`/api/tasks/${id}/claim`, {}));
  }
  leaveTask(id: string): Promise<Task> {
    return firstValueFrom(this.http.post<Task>(`/api/tasks/${id}/leave`, {}));
  }
  manageClaims(
    id: string,
    body: { openingsDelta?: number; claimsClosed?: boolean },
  ): Promise<Task> {
    return firstValueFrom(this.http.post<Task>(`/api/tasks/${id}/claims`, body));
  }
  changeRequester(id: string, userId: string): Promise<Task> {
    return firstValueFrom(
      this.http.post<Task>(`/api/tasks/${id}/requester`, { userId }),
    );
  }

  /** A task's own questionnaire copy, or null when absent (404). */
  async getTaskQuestionnaire(taskId: string): Promise<Questionnaire | null> {
    try {
      return await firstValueFrom(
        this.http.get<Questionnaire>(`/api/tasks/${taskId}/questionnaire`),
      );
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 404) return null;
      throw e;
    }
  }

  // ---- Slice 4: messages + attachments ------------------------------------

  listMessages(
    taskId: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<MessageListResult> {
    const params = new URLSearchParams();
    if (opts.after) params.set('after', opts.after);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return firstValueFrom(
      this.http.get<MessageListResult>(
        `/api/tasks/${taskId}/messages${qs ? `?${qs}` : ''}`,
      ),
    );
  }

  createMessage(
    taskId: string,
    body: { body: string; parentMessageId?: string },
  ): Promise<Message> {
    return firstValueFrom(
      this.http.post<Message>(`/api/tasks/${taskId}/messages`, body),
    );
  }
  updateMessage(id: string, body: string): Promise<Message> {
    return firstValueFrom(this.http.patch<Message>(`/api/messages/${id}`, { body }));
  }
  retireMessage(id: string): Promise<Message> {
    return firstValueFrom(this.http.post<Message>(`/api/messages/${id}/retire`, {}));
  }

  /** Upload a file against an existing message (multipart). */
  uploadAttachment(messageId: string, file: File): Promise<Attachment> {
    const form = new FormData();
    form.append('file', file, file.name);
    return firstValueFrom(
      this.http.post<Attachment>(`/api/messages/${messageId}/attachments`, form),
    );
  }

  /** The ungated download URL for an attachment (use as an anchor href). */
  attachmentUrl(id: string): string {
    return `/api/attachments/${id}`;
  }

  // ---- Slice 5: submissions & review lifecycle ----------------------------

  listSubmissions(taskId: string): Promise<Submission[]> {
    return firstValueFrom(
      this.http.get<Submission[]>(`/api/tasks/${taskId}/submissions`),
    );
  }

  getSubmission(id: string): Promise<Submission> {
    return firstValueFrom(this.http.get<Submission>(`/api/submissions/${id}`));
  }

  /** Submit (or resubmit) a claimant's answers (`task:submit`). */
  submit(taskId: string, answers: SubmitAnswer[]): Promise<Submission> {
    return firstValueFrom(
      this.http.post<Submission>(`/api/tasks/${taskId}/submissions`, { answers }),
    );
  }

  /** Approve / return / reject a submission (`task:review`). */
  reviewSubmission(
    id: string,
    decision: ReviewDecision,
    comment?: string,
  ): Promise<Submission> {
    return firstValueFrom(
      this.http.post<Submission>(`/api/submissions/${id}/review`, { decision, comment }),
    );
  }

  /** Retire a submission with a required reason (`task:retire_submission`). */
  retireSubmission(id: string, reason: string): Promise<Submission> {
    return firstValueFrom(
      this.http.post<Submission>(`/api/submissions/${id}/retire`, { reason }),
    );
  }

  /** Manually complete a task → approved (`task:complete`). */
  completeTask(id: string): Promise<Task> {
    return firstValueFrom(this.http.post<Task>(`/api/tasks/${id}/complete`, {}));
  }
}
