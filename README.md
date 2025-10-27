# CreatorNet MVP

A modern sign-up page for CreatorNet built with Next.js, Tailwind CSS, and Supabase Auth.

## Features

- Mobile-first design (max width 430px)
- Sign up with email/password or OAuth (Google & Apple)
- Clean, minimalist UI with CreatorNet branding
- Error handling and loading states

## Setup

### Prerequisites

You need to have Node.js installed on your system.

### Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables:
Create a `.env.local` file in the root directory:
```
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000/auth](http://localhost:3000/auth) in your browser.

## Supabase Configuration

1. Create a new project at [supabase.com](https://supabase.com)
2. Get your project URL and anon key from the project settings
3. Configure OAuth providers:
   - Go to Authentication > Providers
   - Enable Google and Apple OAuth
   - Add the redirect URL: `http://localhost:3000/auth/callback`
   - For production, update the URL to your production domain

## Project Structure

```
creatornet-mvp/
├── app/
│   ├── auth/
│   │   ├── page.tsx          # Sign up page
│   │   └── callback/
│   │       └── route.ts      # OAuth callback handler
│   ├── globals.css           # Global styles
│   └── layout.tsx            # Root layout
├── lib/
│   └── supabase.ts          # Supabase client configuration
├── package.json
├── tailwind.config.ts        # Tailwind configuration
└── tsconfig.json             # TypeScript configuration
```

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Next Steps

- Complete the onboarding flow (`/onboarding`)
- Create the feed page (`/feed`)
- Add user profile management
- Implement proper user state checking (onboarding completion)






