"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SignInForm } from "@/components/shell/sign-in-form";
import { useSession, sessionSignInAvailable } from "@/lib/session/use-session";

/** A dev-only convenience — refused entirely in production, where signInAvailable is false. */
export default function SignInPage() {
  const session = useSession();
  const router = useRouter();

  const alreadySignedIn = session.isSuccess && session.data.kind === "user";
  // A failed session fetch is treated the same as signInAvailable: false — there's nothing safe to
  // render here without knowing whether sign-in is even available.
  const redirectAway = !session.isPending && (alreadySignedIn || !sessionSignInAvailable(session));

  useEffect(() => {
    if (redirectAway) router.replace("/chat");
  }, [redirectAway, router]);

  if (session.isPending || redirectAway) return null;

  return (
    <div className="flex flex-1 flex-col justify-center px-4 py-16">
      <div className="mx-auto flex w-full max-w-[400px] flex-col gap-6">
        <div>
          <h1 className="font-display text-2xl font-medium">Sign in</h1>
          <p className="mt-1 text-sm text-muted-foreground">Development sign-in — enter any name.</p>
        </div>
        <SignInForm onSuccess={() => router.push("/chat")} />
        <Link href="/chat" className="text-sm text-primary underline-offset-4 hover:underline">
          Continue as a guest
        </Link>
      </div>
    </div>
  );
}
