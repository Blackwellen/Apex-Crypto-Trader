'use client';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, TextInput } from '@/components/ui';

export default function Login() {
  const [email, setEmail] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) location.href = '/dashboard'; else { setErr(j.message ?? 'Sign-in failed'); setBusy(false); }
  }
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-card p-7 shadow-card" aria-labelledby="t">
        <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-accent text-white"><ShieldCheck className="size-5" aria-hidden /></span><h1 id="t" className="text-2xl font-bold">Sign in to APEX</h1></div>
        <p className="text-[13px] text-muted">Development sign-in is available only when the API runs with local dev auth. Production uses Supabase Auth with MFA. APEX never asks for a seed phrase or private key.</p>
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
        <Button variant="primary" type="submit" busy={busy} className="w-full">Continue</Button>
      </form>
    </main>
  );
}
