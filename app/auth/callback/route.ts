import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const origin = requestUrl.origin

  if (code) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey)
    
    await supabase.auth.exchangeCodeForSession(code)
    
    // Check if user exists and has completed onboarding
    const { data: { user } } = await supabase.auth.getUser()
    
    if (user) {
      // Redirect to onboarding or feed based on user status
      // This is a simplified check - you'd want to query your user profile table
      return NextResponse.redirect(`${origin}/onboarding`)
    }
  }

  // Return the user to an error page with instructions
  return NextResponse.redirect(`${origin}/auth`)
}





