import { useQuery } from '@tanstack/react-query';
import { useBacklogClient } from '../BacklogApiProvider';
import { unwrap } from '../client';
import { backlogKeys } from './keys';

/** The signed-in user as backlog-api sees them (normalized email, display name). */
export function useMe() {
  const client = useBacklogClient();
  return useQuery({ queryKey: backlogKeys.me(), queryFn: () => unwrap(client.http.GET('/me')), staleTime: 5 * 60_000 });
}
