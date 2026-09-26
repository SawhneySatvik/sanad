"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeToSessionBroadcast } from "./sync";

/** Mounted once at AppShell so every route hears another tab's sign-in/out/claim/delete-all. */
export function useSessionBroadcastListener(): void {
  const queryClient = useQueryClient();

  useEffect(() => subscribeToSessionBroadcast(queryClient), [queryClient]);
}
