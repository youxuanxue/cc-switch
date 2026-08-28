import { useQuery } from "@tanstack/react-query";
import { cursorApi, type CursorSessionIndexStatus } from "@/lib/api/cursor";

export const cursorSessionIndexQueryKey = ["cursor-session-index"] as const;

export function useCursorSessionIndex() {
  const query = useQuery<CursorSessionIndexStatus>({
    queryKey: cursorSessionIndexQueryKey,
    queryFn: () => cursorApi.getSessionIndexStatus(),
  });

  return {
    status: query.data,
    error: query.error,
    isLoading: query.isPending,
    isError: query.isError,
    refresh: async () => (await query.refetch()).data,
  };
}
