import Link from "next/link";
import { SignInButton, UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";

export async function SiteHeader() {
  const { userId } = await auth();

  return (
    <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-6 py-3">
      <Link href="/" className="font-semibold tracking-tight">
        NFL Analytics
      </Link>
      <nav className="flex items-center gap-4 text-sm">
        {userId ? (
          <>
            <Link href="/dashboard" className="hover:underline">
              Dashboard
            </Link>
            <UserButton />
          </>
        ) : (
          <SignInButton mode="modal">
            <button className="hover:underline" type="button">
              Sign in
            </button>
          </SignInButton>
        )}
      </nav>
    </header>
  );
}
