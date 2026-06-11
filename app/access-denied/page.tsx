import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Access denied · NFL Analytics",
};

export default function AccessDeniedPage() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center p-8 text-center">
      <h1 className="text-2xl font-semibold mb-4">
        You&rsquo;re signed in, but not on the access list.
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400 max-w-md mb-6">
        This area is for friends of the project author. If you should have
        access, ping Jayson with the email address you used
        to sign in and he&rsquo;ll add you.
      </p>
      <Link href="/" className="text-sm underline">
        Back to home
      </Link>
    </main>
  );
}
