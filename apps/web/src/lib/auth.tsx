"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, applySession, refreshSession, setSessionListener } from "./api";
import type { User } from "./types";

type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Lets a logout in one tab sign out the other open tabs too.
const CHANNEL = "mediq-auth";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ status: AuthStatus; user: User | null }>({
    status: "loading",
    user: null,
  });

  useEffect(() => {
    setSessionListener((session) =>
      setState(
        session
          ? { status: "authenticated", user: session.user }
          : { status: "anonymous", user: null },
      ),
    );
    // Restore the session from the refresh cookie on page load.
    void refreshSession();

    const channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL) : null;
    if (channel) {
      channel.onmessage = (e) => {
        if (e.data === "logout") applySession(null);
      };
    }
    return () => {
      setSessionListener(null);
      channel?.close();
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout", undefined, { auth: false });
    } catch {
      // Even if the API is unreachable, clear the local session.
    }
    applySession(null);
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage("logout");
      channel.close();
    }
  }, []);

  const value = useMemo(() => ({ ...state, logout }), [state, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
