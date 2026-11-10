// Imported first by the service worker, so the environment is in place before any API
// module reads it at import time.
import { setDemoEnv } from './demo-env';

setDemoEnv(self.location.origin);
