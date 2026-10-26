import { type FormEvent, useState } from "react";

/** One-time staff sign-in per device. The token is kept in this browser only and never compiled into the app. */
export function StaffSignIn({ rejected, onSubmit }: { rejected: boolean; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return <main className="loading">
    <form className="sign-in" onSubmit={submit}>
      <span className="brand-mark" aria-hidden="true">P5</span>
      <h1>Staff sign-in</h1>
      <p>Enter the access token for this café's server (the <code>PS5_CAFE_API_TOKEN</code> it was started with). This device remembers it.</p>
      {rejected && <p className="book-error" role="alert">That token was not accepted. Check it and try again.</p>}
      <label className="book-field">
        <span>Access token</span>
        <input type="password" autoComplete="current-password" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
      </label>
      <button type="submit" className="primary">Sign in</button>
    </form>
  </main>;
}
