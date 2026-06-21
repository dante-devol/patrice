// jest-preset-angular setup: installs the Angular TestBed + zone.js test environment
// so component/service specs can use TestBed.configureTestingModule (issue #34).
import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';

setupZoneTestEnv();
