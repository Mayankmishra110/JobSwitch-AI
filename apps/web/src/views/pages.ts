/**
 * Minimal server-rendered pages.
 *
 * SCOPE NOTE: the architecture (ADR §17) puts a static frontend on a CDN with
 * the API separate. That split arrives when there is a real dashboard to build
 * (Phase 6). For Phase 1 the only UI is four auth forms, and standing up a
 * separate SPA build to render them would be work with no user visible.
 *
 * Nothing here blocks the split: auth is a cookie on the registrable domain,
 * so a static app served from app.<domain> against api.<domain> works with the
 * same session mechanism.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  :root { color-scheme: light dark; --fg:#17191c; --bg:#fbfbfa; --muted:#666c73;
          --border:#e1e3df; --accent:#2b3a67; --err:#95372b; --ok:#2c6a4a; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e9eae6; --bg:#131518; --muted:#93999f; --border:#2b3036;
            --accent:#9db0e0; --err:#e08878; --ok:#79c79b; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6
         ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; padding:24px; }
  main { width:100%; max-width:400px; }
  h1 { font-size:22px; letter-spacing:-.02em; margin:0 0 6px; }
  p.sub { color:var(--muted); margin:0 0 24px; font-size:14.5px; }
  label { display:block; font-size:13px; font-weight:600; margin:0 0 5px; }
  input { width:100%; padding:9px 11px; margin:0 0 16px; font-size:15px;
          border:1px solid var(--border); border-radius:4px;
          background:var(--bg); color:var(--fg); }
  input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; padding:10px; font-size:15px; font-weight:600;
           border:0; border-radius:4px; background:var(--accent); color:var(--bg);
           cursor:pointer; }
  .alt { display:block; text-align:center; padding:10px; margin-top:10px;
         border:1px solid var(--border); border-radius:4px; color:var(--fg);
         text-decoration:none; font-size:14.5px; }
  .msg { padding:10px 12px; border-radius:4px; font-size:14px; margin:0 0 18px;
         border:1px solid; }
  .msg.error { color:var(--err); border-color:var(--err); }
  .msg.ok { color:var(--ok); border-color:var(--ok); }
  nav { margin-top:20px; font-size:14px; text-align:center; }
  nav a { color:var(--accent); }
  dl { border:1px solid var(--border); border-radius:4px; padding:14px 16px;
       margin:0 0 18px; font-size:14px; }
  dt { color:var(--muted); font-size:12px; text-transform:uppercase;
       letter-spacing:.08em; margin-top:10px; }
  dt:first-child { margin-top:0; }
  dd { margin:2px 0 0; font-family:ui-monospace, monospace; word-break:break-all; }
`;

export function layout(
  title: string,
  body: string,
  options: { error?: string | null; notice?: string | null } = {},
): string {
  const alert = options.error
    ? `<div class="msg error">${escapeHtml(options.error)}</div>`
    : options.notice
      ? `<div class="msg ok">${escapeHtml(options.notice)}</div>`
      : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · JobSwitch</title>
<style>${STYLES}</style>
</head><body><main>${alert}${body}</main></body></html>`;
}

const googleButton = (enabled: boolean) =>
  enabled ? `<a class="alt" href="/auth/google">Continue with Google</a>` : '';

export function loginPage(opts: {
  error?: string | null;
  notice?: string | null;
  googleEnabled: boolean;
}): string {
  return layout(
    'Sign in',
    `<h1>Sign in</h1>
     <p class="sub">Welcome back.</p>
     <form method="post" action="/auth/login">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="email" required autofocus>
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="current-password" required>
       <button type="submit">Sign in</button>
     </form>
     ${googleButton(opts.googleEnabled)}
     <nav><a href="/signup">Create an account</a> · <a href="/forgot-password">Forgot password?</a></nav>`,
    opts,
  );
}

export function signupPage(opts: {
  error?: string | null;
  googleEnabled: boolean;
}): string {
  return layout(
    'Create account',
    `<h1>Create your account</h1>
     <p class="sub">Start tracking openings at the companies you care about.</p>
     <form method="post" action="/auth/signup">
       <label for="fullName">Name</label>
       <input id="fullName" name="fullName" type="text" autocomplete="name">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="email" required>
       <label for="password">Password</label>
       <input id="password" name="password" type="password" autocomplete="new-password"
              minlength="10" required>
       <button type="submit">Create account</button>
     </form>
     ${googleButton(opts.googleEnabled)}
     <nav><a href="/login">I already have an account</a></nav>`,
    opts,
  );
}

export function forgotPasswordPage(opts: {
  error?: string | null;
  notice?: string | null;
}): string {
  return layout(
    'Reset password',
    `<h1>Reset your password</h1>
     <p class="sub">We'll email you a link if an account exists for that address.</p>
     <form method="post" action="/auth/forgot-password">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="email" required autofocus>
       <button type="submit">Send reset link</button>
     </form>
     <nav><a href="/login">Back to sign in</a></nav>`,
    opts,
  );
}

export function resetPasswordPage(opts: {
  token: string;
  error?: string | null;
}): string {
  return layout(
    'Set a new password',
    `<h1>Set a new password</h1>
     <p class="sub">This signs you out everywhere else.</p>
     <form method="post" action="/auth/reset-password">
       <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
       <label for="password">New password</label>
       <input id="password" name="password" type="password" autocomplete="new-password"
              minlength="10" required autofocus>
       <button type="submit">Update password</button>
     </form>
     <nav><a href="/login">Back to sign in</a></nav>`,
    opts,
  );
}

export function dashboardPage(opts: {
  email: string;
  accountId: string;
  userId: string;
  role: string;
}): string {
  return layout(
    'Dashboard',
    `<h1>You're signed in</h1>
     <p class="sub">Phase 1 shell. Job ingestion arrives in Phase 2.</p>
     <dl>
       <dt>Email</dt><dd>${escapeHtml(opts.email)}</dd>
       <dt>Account</dt><dd>${escapeHtml(opts.accountId)}</dd>
       <dt>User</dt><dd>${escapeHtml(opts.userId)}</dd>
       <dt>Role</dt><dd>${escapeHtml(opts.role)}</dd>
     </dl>
     <form method="post" action="/auth/logout"><button type="submit">Sign out</button></form>`,
  );
}
