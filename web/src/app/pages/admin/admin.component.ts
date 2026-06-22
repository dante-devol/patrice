import { Component, signal } from '@angular/core';
import { RolesAdminComponent } from './roles-admin.component';
import { DivisionsAdminComponent } from './divisions-admin.component';
import { TeamsAdminComponent } from './teams-admin.component';
import { UsersAdminComponent } from './users-admin.component';
import { PermissionsAdminComponent } from './permissions-admin.component';
import { SettingsAdminComponent } from './settings-admin.component';
import { ActivityAdminComponent } from './activity-admin.component';

type Tab =
  | 'roles'
  | 'divisions'
  | 'teams'
  | 'users'
  | 'permissions'
  | 'settings'
  | 'activity';

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
  ],
  template: `
    <div class="panel">
      <nav class="tabs">
        @for (t of tabs; track t) {
          <button [class.secondary]="tab() !== t" (click)="tab.set(t)">{{ t }}</button>
        }
      </nav>
    </div>
    @switch (tab()) {
      @case ('roles') { <roles-admin /> }
      @case ('divisions') { <divisions-admin /> }
      @case ('teams') { <teams-admin /> }
      @case ('users') { <users-admin /> }
      @case ('permissions') { <permissions-admin /> }
      @case ('settings') { <settings-admin /> }
      @case ('activity') { <activity-admin /> }
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
  ];
  readonly tab = signal<Tab>('roles');
}
