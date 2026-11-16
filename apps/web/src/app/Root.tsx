import { AuthProvider } from '../auth';
import { RuntimeConfigProvider } from '../config/RuntimeConfigProvider';
import { Bootstrap } from './Bootstrap';

export function Root() {
  return <RuntimeConfigProvider><AuthProvider><Bootstrap /></AuthProvider></RuntimeConfigProvider>;
}
