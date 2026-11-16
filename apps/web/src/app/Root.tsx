import { BacklogApiProvider } from '../api';
import { AuthProvider } from '../auth';
import { RuntimeConfigProvider } from '../config/RuntimeConfigProvider';
import { Projects } from './Projects';

export function Root() {
  return <RuntimeConfigProvider><AuthProvider><BacklogApiProvider><Projects /></BacklogApiProvider></AuthProvider></RuntimeConfigProvider>;
}
