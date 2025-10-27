'use client'

import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function AuthPage() {
  const [email, setEmail] = useState('')
  const [showEmail, setShowEmail] = useState(false)
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const signInGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${location.origin}/dashboard` }
    })
    if (error) setMsg(error.message)
  }

  // Placeholder — Apple will come later
  const signInApple = async () => {
    setMsg('Apple Sign In coming soon.')
  }

  const sendEmailOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/dashboard` }
    })
    setLoading(false)
    setMsg(error ? error.message : 'Check your email for the magic link.')
  }

  return (
    <main className="min-h-dvh flex items-center justify-center px-5 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6" />
        <h1 className="text-center text-[22px] font-extrabold tracking-wide uppercase">
          Sign up for CreatorNet
        </h1>
        <p className="mt-1 text-center text-base font-semibold text-indigo-700">
          Scroll, Learn, Earn.
        </p>

        {!showEmail ? (
          <button
            onClick={() => setShowEmail(true)}
            className="mt-6 w-full rounded-2xl px-5 py-3 text-base font-semibold 
                       bg-indigo-500 text-white shadow-sm active:scale-[0.99] transition"
          >
            Phone or Email
          </button>
        ) : (
          <form onSubmit={sendEmailOtp} className="mt-6 space-y-3">
            <input
              type="email"
              required
              inputMode="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border px-4 py-3 text-base"
            />
            <button
              disabled={loading}
              className="w-full rounded-2xl px-5 py-3 text-base font-semibold 
                         bg-indigo-500 text-white shadow-sm disabled:opacity-60"
            >
              {loading ? 'Sending…' : 'Continue with Email'}
            </button>
            <button
              type="button"
              onClick={() => setShowEmail(false)}
              className="w-full text-sm text-gray-600 underline"
            >
              Back
            </button>
          </form>
        )}

        <div className="my-4 text-center text-sm text-gray-500">or</div>

        <div className="space-y-3">
          <button
            onClick={signInApple}
            className="w-full rounded-xl border px-4 py-3 text-base font-medium"
          >
            Continue with Apple
          </button>
          <button
            onClick={signInGoogle}
            className="w-full rounded-xl border px-4 py-3 text-base font-medium"
          >
            Continue with Google
          </button>
        </div>

        <p className="mt-6 text-center text-sm">
          Have an account?{' '}
          <Link href="/auth" className="font-medium underline">
            Log in
          </Link>
        </p>

        <p className="mt-4 text-center text-[11px] leading-4 text-gray-500">
          By signing up, you agree to our Terms, Privacy Policy and Cookies Policy.
        </p>

        {msg && (
          <p className="mt-4 text-center text-xs text-red-600">{msg}</p>
        )}
        <div className="mt-8" />
      </div>
    </main>
  )
}
