import { BacklogApiProvider } from '../api';
import { AuthProvider } from '../auth';
import { AgentClientProvider } from '../run';
import { RuntimeConfigProvider } from '../config/RuntimeConfigProvider';
import { Projects } from './Projects';

export function Root() {
  return <RuntimeConfigProvider><AuthProvider><BacklogApiProvider><AgentClientProvider><Projects /></AgentClientProvider></BacklogApiProvider></AuthProvider></RuntimeConfigProvider>;
}
