import { Component, signal } from '@angular/core';
import { RolesAdminComponent } from './roles-admin.component';
import { DivisionsAdminComponent } from './divisions-admin.component';
import { TeamsAdminComponent } from './teams-admin.component';
import { UsersAdminComponent } from './users-admin.component';
import { PermissionsAdminComponent } from './permissions-admin.component';
import { SettingsAdminComponent } from './settings-admin.component';
import { ActivityAdminComponent } from './activity-admin.component';
import { InvitationsComponent } from '../invitations.component';
import { IntegrationsAdminComponent } from './integrations-admin.component';

type Tab =
  | 'roles'
  | 'divisions'
  | 'teams'
  | 'users'
  | 'permissions'
  | 'settings'
  | 'activity'
  | 'invitations'
  | 'integrations';

/** Admin-area shell (Slice 2). Tabbed host over the dumb editor components. */
@Component({
  standalone: true,
  imports: [
    RolesAdminComponent,
    DivisionsAdminComponent,
    TeamsAdminComponent,
    UsersAdminComponent,
    PermissionsAdminComponent,
    SettingsAdminComponent,
    ActivityAdminComponent,
    InvitationsComponent,
    IntegrationsAdminComponent,
  ],
  template: `
    <nav class="admin-tabs">
      @for (t of tabs; track t) {
        <button class="admin-tab" [class.is-active]="tab() === t" (click)="tab.set(t)">{{ t }}</button>
      }
    </nav>
    @switch (tab()) {
      @case ('roles') { <roles-admin /> }
      @case ('divisions') { <divisions-admin /> }
      @case ('teams') { <teams-admin /> }
      @case ('users') { <users-admin /> }
      @case ('permissions') { <permissions-admin /> }
      @case ('settings') { <settings-admin /> }
      @case ('activity') { <activity-admin /> }
      @case ('invitations') { <invitations-admin /> }
      @case ('integrations') { <integrations-admin /> }
    }
  `,
})
export class AdminComponent {
  readonly tabs: Tab[] = [
    'roles',
    'divisions',
    'teams',
    'users',
    'permissions',
    'settings',
    'activity',
    'invitations',
    'integrations',
  ];
  readonly tab = signal<Tab>('roles');
}
