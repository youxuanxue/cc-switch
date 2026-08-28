import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cursorApi,
  type CursorOfficialAuthUpdate,
  type CursorOfficialStatus,
} from "@/lib/api/cursor";

export const cursorOfficialStatusQueryKey = ["cursor-official-status"] as const;

export function useCursorOfficial() {
  const queryClient = useQueryClient();
  const [isUpdating, setIsUpdating] = useState(false);
  const statusQuery = useQuery<CursorOfficialStatus>({
    queryKey: cursorOfficialStatusQueryKey,
    queryFn: () => cursorApi.getOfficialStatus(),
  });

  const clearMutation = useMutation({
    mutationFn: () => cursorApi.clearUserApiKey(),
    onSuccess: (status) => {
      queryClient.setQueryData(cursorOfficialStatusQueryKey, status);
    },
  });

  const loginMutation = useMutation({
    mutationFn: () => cursorApi.launchLogin(),
  });

  const updateAuth = async (update: CursorOfficialAuthUpdate) => {
    setIsUpdating(true);
    try {
      const status = await cursorApi.updateOfficialAuth(update);
      queryClient.setQueryData(cursorOfficialStatusQueryKey, status);
      return status;
    } finally {
      setIsUpdating(false);
    }
  };

  return {
    status: statusQuery.data,
    error: statusQuery.error,
    isLoading: statusQuery.isPending,
    isError: statusQuery.isError,
    updateAuth,
    clearUserApiKey: clearMutation.mutateAsync,
    launchLogin: loginMutation.mutateAsync,
    refresh: async () => (await statusQuery.refetch()).data,
    isUpdating,
    isClearing: clearMutation.isPending,
    isLaunchingLogin: loginMutation.isPending,
    isPending: isUpdating || clearMutation.isPending || loginMutation.isPending,
  };
}
