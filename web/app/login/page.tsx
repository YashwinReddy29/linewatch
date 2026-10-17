import type { Metadata } from "next";

import { LoginForm } from "@/components/LoginForm";

export const metadata: Metadata = { title: "Sign in | Linewatch" };

export default function LoginPage() {
  return <LoginForm />;
}
