import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export default function LoginPage() {
  return (
    <main className="centered-page">
      {/* LoginForm reads the ?reset=1 notice via useSearchParams, which
          opts it into client-side rendering - Next requires a Suspense
          boundary around that so the rest of this otherwise-static page
          can still prerender. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
